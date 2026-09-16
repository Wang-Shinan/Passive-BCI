#!/usr/bin/env python3
"""OmniBCI LSL EEG -> WebSocket bridge for the acquisition UI."""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any

import numpy as np
from pylsl import StreamInlet, resolve_byprop

SCHEMA_VERSION = 1
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8771
DEFAULT_SAMPLE_RATE = 250.0


def _channel_names(info: Any) -> list[str]:
    count = int(info.channel_count())
    names: list[str] = []
    try:
        channel = info.desc().child("channels").child("channel")
        for _ in range(count):
            label = channel.child_value("label").strip()
            names.append(label or f"CH{len(names) + 1}")
            channel = channel.next_sibling("channel")
    except Exception:
        names = []
    return names if len(names) == count else [f"CH{i + 1}" for i in range(count)]


def _find_omni_stream(timeout: float = 6.0) -> Any:
    streams = resolve_byprop("type", "EEG", timeout=timeout)
    if not streams:
        raise RuntimeError("未发现 LSL EEG 流。请在 OmniBCI 中连接设备并开始测量。")
    for stream in streams:
        text = f"{stream.name()} {stream.source_id()}".lower()
        if "omni" in text:
            return stream
    return streams[0]


async def handle_client(websocket: Any) -> None:
    inlet: StreamInlet | None = None
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=8.0)
        msg = json.loads(raw) if isinstance(raw, str) else {}
        if not isinstance(msg, dict) or msg.get("type") != "subscribe":
            await websocket.close(1003, "subscribe must be JSON")
            return
        requested_stream = "filtered" if msg.get("stream") == "filtered" else "raw"

        info = await asyncio.to_thread(_find_omni_stream)
        inlet = StreamInlet(info, max_buflen=5, max_chunklen=32, recover=True)
        await asyncio.to_thread(inlet.open_stream, 5.0)
        channels = _channel_names(info)
        sample_rate = float(info.nominal_srate()) or DEFAULT_SAMPLE_RATE
        session_id = f"lsl-{info.source_id() or info.uid()}"
        await websocket.send(
            json.dumps(
                {
                    "type": "hello",
                    "schema_version": SCHEMA_VERSION,
                    "stream": requested_stream,
                    "sample_rate": sample_rate,
                    "channels": channels,
                    "unit": "uV",
                    "session_id": session_id,
                    "source": "lsl",
                    "lsl_name": info.name(),
                    "lsl_source_id": info.source_id(),
                },
                separators=(",", ":"),
            )
        )

        sequence = 0
        packet_count = 0
        while True:
            samples, _timestamps = await asyncio.to_thread(
                inlet.pull_chunk, 0.25, 32
            )
            if not samples:
                await asyncio.sleep(0.002)
                continue
            values = np.asarray(samples, dtype="<f4")
            if values.ndim != 2 or values.shape[1] != len(channels):
                continue
            valid = np.isfinite(values).all(axis=1)
            if not valid.all():
                values = np.nan_to_num(values, copy=False)
            values = np.ascontiguousarray(values)
            count = int(values.shape[0])
            seq = [value & 0xFFFFFFFF for value in range(sequence, sequence + count)]
            sequence = (sequence + count) & 0xFFFFFFFF
            packet_count += 1
            header = {
                "type": "data",
                "schema_version": SCHEMA_VERSION,
                "dtype": "float32",
                "shape": [count, len(channels)],
                "sample_rate": sample_rate,
                "channels": channels,
                "unit": "uV",
                "stream": requested_stream,
                "sequence": seq,
                "valid": valid.tolist(),
                "modes": [0] * count,
                "generation": 0,
                "session_id": session_id,
                "packet_count": packet_count,
                "packet_loss_count": 0,
            }
            await websocket.send(json.dumps(header, separators=(",", ":")))
            await websocket.send(values.tobytes(order="C"))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        try:
            await websocket.send(
                json.dumps({"type": "error", "message": str(exc)}, separators=(",", ":"))
            )
        except Exception:
            pass
    finally:
        if inlet is not None:
            try:
                inlet.close_stream()
            except Exception:
                pass


async def main_async(host: str, port: int) -> None:
    from websockets.asyncio.server import serve

    async with serve(handle_client, host, port, max_size=16 * 1024 * 1024, origins=None):
        print(
            f"[omni-lsl-bridge] ready — ws://{host}:{port}/v1/stream (waiting for LSL EEG)",
            flush=True,
        )
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=DEFAULT_WS_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_WS_PORT)
    args = parser.parse_args()
    try:
        asyncio.run(main_async(args.host, args.port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
