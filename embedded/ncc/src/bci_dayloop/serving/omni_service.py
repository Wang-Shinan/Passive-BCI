"""One SDK device owner and inference worker, with bounded result fan-out."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
import time

from .omni_source import OmniSourceConfig, OmniWindowAssembler, connect_board, read_available, validate_board
from .protocol import ProtocolError, dumps, error_message, parse_feedback, parse_json_object, prediction_message
from .server import ALLOWED_PATHS, _connection_path
from .tcp_broadcast import TcpBroadcastHub, attach_follow_info, start_follow_server


async def _blocking(function, *args):
    """Cancellation waits for native calls, before closing their device/model."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def serve_omni_model_service(
    backend, config: OmniSourceConfig, *, host="127.0.0.1", port=8768,
    tcp_host="0.0.0.0", tcp_port=8769, tcp_enabled=True,
    stop: asyncio.Event | None = None, board_factory=connect_board,
    read_batch=read_available,
) -> None:
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed

    hello = backend.hello_payload()
    contract = hello["input"]
    assembler = OmniWindowAssembler(config.channel_names, contract["window_sec"], contract["step_sec"],
                                    electrode_names=config.electrode_names, electrode_positions=config.electrode_positions)
    hello["input"] = {**contract, "source": "omni-sdk", "channel_names": list(config.channel_names), "sample_rate": 250}
    if config.electrode_names is not None:
        hello["input"]["electrode_names"] = config.electrode_names
    if config.electrode_positions is not None:
        hello["input"]["electrode_positions"] = config.electrode_positions
    pending: asyncio.Queue = asyncio.Queue(maxsize=1)
    clients: dict[object, asyncio.Queue] = {}
    model_lock = asyncio.Lock()
    seen_feedback: OrderedDict[str, None] = OrderedDict()
    hub = TcpBroadcastHub()
    tcp_server = None
    board = None
    started = False
    workers: list[asyncio.Task] = []
    dropped = 0

    def publish(payload):
        hub.publish(payload)
        for websocket, queue in list(clients.items()):
            if queue.full():
                # Disconnect slow peers; never accumulate stale predictions.
                clients.pop(websocket, None)
                asyncio.create_task(websocket.close(1013, "model client is too slow"))
            else:
                queue.put_nowait(payload)

    async def reader():
        nonlocal dropped
        last_data = time.monotonic()
        while True:
            batch = await _blocking(read_batch, board)
            now = time.monotonic()
            if batch is None or not len(batch.eeg_uv):
                if now - last_data > config.idle_timeout_sec:
                    raise RuntimeError("Omni source stopped delivering EEG")
                continue
            last_data = now
            old_segment = assembler.segment_id
            old_id = assembler.window_id
            if now - batch.received_at > config.max_age_sec:
                assembler.reset()
                window = None
            else:
                window = assembler.push(batch)
            if assembler.segment_id != old_segment:
                if not pending.empty():
                    pending.get_nowait()
                    dropped += 1
                publish({"type": "error", "code": "source_reset", "message": "Omni 连续段已重置，等待完整 EEG 窗口", "schema_version": 1})
            dropped += max(0, assembler.window_id - old_id - (1 if window is not None else 0))
            if window is not None:
                if not pending.empty():
                    pending.get_nowait()
                    dropped += 1
                pending.put_nowait((window, batch.received_at))

    async def infer():
        nonlocal dropped
        while True:
            window, received_at = await pending.get()
            async with model_lock:
                # Feedback may have held the model lock while newer data arrived.
                while not pending.empty():
                    window, received_at = pending.get_nowait()
                    dropped += 1
                if window.segment_id != assembler.segment_id or time.monotonic() - received_at > config.max_age_sec:
                    dropped += 1
                    continue
                payload = prediction_message(await _blocking(backend.predict, window))
            if window.segment_id != assembler.segment_id or time.monotonic() - received_at > config.max_age_sec:
                dropped += 1
                continue
            payload.update(
                source_latency_ms=max(0.0, (time.monotonic() - received_at) * 1000),
                source_dropped_windows=dropped,
                window_end_time_sec=window.end_time_sec,
            )
            publish(payload)

    async def handler(websocket):
        if _connection_path(websocket) not in ALLOWED_PATHS:
            await websocket.close(1008, "unsupported path")
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        clients[websocket] = queue
        queue.put_nowait(hello)

        async def send():
            while True:
                await asyncio.wait_for(websocket.send(dumps(await queue.get())), timeout=2)

        async def receive():
            async for raw in websocket:
                try:
                    if not isinstance(raw, str):
                        raise ProtocolError("SDK source does not accept browser EEG", code="source_owned")
                    message = parse_json_object(raw)
                    if message.get("type") == "hello":
                        await queue.put(hello)
                    elif message.get("type") == "feedback":
                        feedback = parse_feedback(message)
                        async with model_lock:
                            if feedback.feedback_id in seen_feedback:
                                ack = {"type": "feedback_ack", "schema_version": 1, "feedback_id": feedback.feedback_id,
                                       "observation_id": feedback.observation_id, "accepted": False, "duplicate": True,
                                       "reason": "duplicate feedback_id"}
                            else:
                                # Remember even failed attempts; don't repeat a partially applied update.
                                seen_feedback[feedback.feedback_id] = None
                                if len(seen_feedback) > 4096:
                                    seen_feedback.popitem(last=False)
                                ack = await _blocking(backend.ack_feedback, feedback)
                        await queue.put(ack)
                        hub.publish(ack)
                    else:
                        raise ProtocolError("SDK source accepts only hello and feedback", code="source_owned")
                except Exception as error:
                    await queue.put(error_message(error))

        tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ConnectionClosed, TimeoutError):
            pass
        finally:
            clients.pop(websocket, None)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    try:
        connection = asyncio.create_task(asyncio.to_thread(board_factory, config))
        try:
            board = await asyncio.shield(connection)
        except asyncio.CancelledError:
            board = await connection
            raise
        await _blocking(validate_board, board)
        await _blocking(board.start)
        started = True
        if tcp_enabled:
            tcp_server = await start_follow_server(hub, host=tcp_host, port=tcp_port)
            hello = attach_follow_info(hello, bind_host=tcp_host, port=tcp_port)
        hub.set_hello(hello)
        async with serve(handler, host, port, compression=None, max_size=64 * 1024):
            print(f"[model-service] ws://{host}:{port}/v1/model · Omni SDK direct input", flush=True)
            print("[model-service] waiting for Omni SDK windows...", flush=True)
            workers = [asyncio.create_task(reader()), asyncio.create_task(infer())]
            if stop is not None:
                workers.append(asyncio.create_task(stop.wait()))
            done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    finally:
        for task in workers:
            task.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        if tcp_server is not None:
            tcp_server.close()
            await tcp_server.wait_closed()
        if board is not None:
            try:
                if started:
                    await _blocking(board.stop)
            finally:
                await _blocking(board.close)
