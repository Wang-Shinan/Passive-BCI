"""Single ESP32 owner shared by acquisition displays and local model workers."""
from __future__ import annotations

import asyncio
from dataclasses import asdict
import json
import time
from types import SimpleNamespace
import uuid

import numpy as np

from .omni_source import read_available

CHANNELS = [f"CH{i}" for i in range(1, 9)]
RELAY_URL = "ws://127.0.0.1:8772/v1/stream"


async def blocking(fn, *args):
    task = asyncio.create_task(asyncio.to_thread(fn, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


def encode_batch(batch, session_id):
    values = np.ascontiguousarray(batch.eeg_uv, dtype="<f4")
    valid = np.asarray(batch.valid) & np.isfinite(values).all(axis=1)
    return ({
        "type": "data", "schema_version": 1, "dtype": "float32", "stream": "raw",
        "shape": list(values.shape), "channels": CHANNELS, "unit": "uV",
        "sample_rate": batch.sample_rate_hz, "sequence": batch.sequence.tolist(),
        "valid": valid.tolist(), "modes": batch.mode.tolist(),
        "generation": batch.generation, "session_id": session_id,
        "sample_indices": batch.sample_indices.tolist(), "received_at": batch.received_at,
    }, values.tobytes())


class OmniRelay:
    def __init__(self, board_factory=None, read_batch=read_available):
        if board_factory is None:
            from omnibci import Board
            board_factory = lambda endpoint: Board.connect(endpoint, timeout=20)
        self.board_factory = board_factory
        self.read_batch = read_batch
        self.lock = asyncio.Lock()
        self.clients = set()
        self.endpoint = None
        self.worker = None
        self.ready = None

    async def acquire(self, endpoint, queue):
        if not isinstance(endpoint, str) or not endpoint.startswith("ble://") or not endpoint[6:]:
            raise ValueError("请选择搜索结果中的 BLE 设备")
        async with self.lock:
            if self.clients and self.endpoint != endpoint:
                raise ValueError("SDK 正在使用另一台设备，请先断开采集和模型连接")
            self.clients.add(queue)
            if self.worker is None:
                self.endpoint = endpoint
                self.ready = asyncio.get_running_loop().create_future()
                self.worker = asyncio.create_task(self.run(endpoint))
            ready = self.ready
        return await asyncio.shield(ready)

    async def release(self, queue):
        async with self.lock:
            self.clients.discard(queue)
            if not self.clients and self.worker is not None:
                self.worker.cancel()
                await asyncio.gather(self.worker, return_exceptions=True)
                self.worker = None
                self.endpoint = None

    def publish(self, item):
        for queue in self.clients:
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(({"type": "error", "message": "SDK 接收积压，请重新连接"}, None))
            else:
                queue.put_nowait(item)

    async def run(self, endpoint):
        board = None
        started = False
        try:
            connecting = asyncio.create_task(asyncio.to_thread(self.board_factory, endpoint))
            try:
                board = await asyncio.shield(connecting)
            except asyncio.CancelledError:
                board = await connecting
                raise
            config = await blocking(board.get_config)
            await blocking(board.start)
            started = True
            session_id = uuid.uuid4().hex
            self.ready.set_result({"type": "hello", "schema_version": 1, "stream": "raw",
                "sample_rate": 250, "channels": CHANNELS, "unit": "uV", "source": "omni-sdk",
                "session_id": session_id, "frontend_config": asdict(config)})
            last_data = time.monotonic()
            while True:
                batch = await blocking(self.read_batch, board)
                if batch is not None:
                    last_data = time.monotonic()
                    self.publish(encode_batch(batch, session_id))
                elif time.monotonic() - last_data > 5:
                    raise RuntimeError("SDK 已超过 5 秒未收到 EEG，请检查设备连接")
        except Exception as error:
            if not self.ready.done():
                self.ready.set_exception(error)
                self.ready.exception()  # also observed if the first subscriber disconnected
            self.publish(({"type": "error", "message": str(error)}, None))
        finally:
            if board is not None:
                try:
                    if started:
                        await blocking(board.stop)
                finally:
                    await blocking(board.close)

    async def handle(self, websocket):
        queue = asyncio.Queue(maxsize=32)
        try:
            request = json.loads(await asyncio.wait_for(websocket.recv(), 8))
            if request.get("type") != "subscribe" or request.get("stream", "raw") != "raw":
                raise ValueError("SDK 仅支持原始 EEG 订阅")
            hello = await self.acquire(request.get("endpoint"), queue)
            await websocket.send(json.dumps(hello))
            async def send():
                while True:
                    header, data = await queue.get()
                    await asyncio.wait_for(websocket.send(json.dumps(header)), 2)
                    if data is None:
                        await websocket.close(1011, "SDK stream failed")
                        return
                    await asyncio.wait_for(websocket.send(data), 2)
            sender = asyncio.create_task(send())
            closed = asyncio.create_task(websocket.wait_closed())
            try:
                done, _ = await asyncio.wait([sender, closed], return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                sender.cancel()
                closed.cancel()
                await asyncio.gather(sender, closed, return_exceptions=True)
        except Exception as error:
            try:
                await websocket.send(json.dumps({"type": "error", "message": str(error)}))
            except Exception:
                pass
        finally:
            await self.release(queue)


class RelayBoard:
    """Synchronous Board facade: timestamps/indices stay on the local SDK timeline."""
    def __init__(self, endpoint):
        from websockets.sync.client import connect
        self.socket = connect(RELAY_URL, open_timeout=25, compression=None)
        self.header = None
        try:
            self.socket.send(json.dumps({"type": "subscribe", "stream": "raw", "endpoint": endpoint}))
            hello = json.loads(self.socket.recv(timeout=25))
            if hello.get("type") != "hello" or hello.get("source") != "omni-sdk":
                raise ValueError(hello.get("message", "Invalid SDK relay hello"))
            self.config = SimpleNamespace(**hello["frontend_config"])
        except BaseException:
            self.socket.close()
            raise

    def get_config(self):
        return self.config

    def start(self):
        pass

    def stop(self):
        pass

    def close(self):
        self.socket.close()

    def read(self, *, timeout=0.1):
        try:
            if self.header is None:
                self.header = json.loads(self.socket.recv(timeout=timeout))
            if self.header.get("type") != "data":
                raise ValueError(self.header.get("message", "Invalid SDK relay data"))
            raw = self.socket.recv(timeout=timeout)
        except TimeoutError:
            return None
        header, self.header = self.header, None
        if not isinstance(raw, bytes) or header.get("shape", [0, 0])[1] != 8:
            raise ValueError("Invalid SDK relay binary batch")
        return SimpleNamespace(
            eeg_uv=np.frombuffer(raw, dtype="<f4").reshape(header["shape"]),
            valid=np.asarray(header["valid"], dtype=bool),
            sample_indices=np.asarray(header["sample_indices"], dtype=np.uint64),
            generation=(header["session_id"], header["generation"]),
            sample_rate_hz=header["sample_rate"], received_at=header["received_at"],
        )
