#!/usr/bin/env python3
"""Neuracle/JellyFish → WebSocket bridge for Passive BCI acquisition UI.

Reuses oi-mi's `collect.neuracle_api.DataServerThread` (博睿康转发协议).

Usage:
  OI_MI_ROOT=/path/to/oi-mi python bridges/neuracle/ws_bridge.py
  # default OI_MI_ROOT: ../../oi-mi next to Passive BCI, or ~/Documents/oi-mi

WebSocket: ws://127.0.0.1:8766/v1/stream
Subscribe: {"type":"subscribe","host":"127.0.0.1","port":8712,
            "eeg_channel_names":["Fpz","Fp1",...]}  # optional; omit = all EEG
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

SCHEMA_VERSION = 1
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8766
DEFAULT_JF_HOST = "127.0.0.1"
DEFAULT_JF_PORT = 8712

# Verified 59-ch scalp montage from oi-mi (excludes ECG/HEOR/HEOL/VEOU/VEOL).
NEURACLE_59_EEG_CHANNEL_NAMES: tuple[str, ...] = (
    "Fpz", "Fp1", "Fp2", "AF3", "AF4", "AF7", "AF8", "Fz",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "FCz",
    "FC1", "FC2", "FC3", "FC4", "FC5", "FC6", "FT7", "FT8",
    "Cz", "C1", "C2", "C3", "C4", "C5", "C6", "T7", "T8",
    "CP1", "CP2", "CP3", "CP4", "CP5", "CP6", "TP7", "TP8",
    "Pz", "P3", "P4", "P5", "P6", "P7", "P8", "POz", "PO3",
    "PO4", "PO5", "PO6", "PO7", "PO8", "Oz", "O1", "O2",
)


def resolve_oi_mi_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("OI_MI_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    here = Path(__file__).resolve()
    candidates = [
        here.parents[3] / "oi-mi",  # .../Documents/oi-mi when Passive BCI is sibling
        here.parents[2].parent / "oi-mi",
        Path.home() / "Documents" / "oi-mi",
    ]
    for path in candidates:
        if (path / "collect" / "neuracle_api.py").is_file():
            return path.resolve()
    raise SystemExit(
        "Cannot find oi-mi (collect/neuracle_api.py). "
        "Set OI_MI_ROOT or pass --oi-mi-root."
    )


def normalize_name(name: str) -> str:
    return "".join(str(name).split()).upper()


class NeuracleSession:
    def __init__(
        self,
        host: str,
        port: int,
        eeg_names: list[str] | None,
        source_sfreq: float,
        ready_timeout: float,
        select_all_forwarded: bool = False,
    ) -> None:
        from collect.neuracle_api import DataServerThread

        self.host = host
        self.port = port
        self.requested_names = tuple(eeg_names) if eeg_names else ()
        self.select_all_forwarded = bool(select_all_forwarded)
        self.select_all_eeg = (not select_all_forwarded) and eeg_names is not None and len(eeg_names) == 0
        self.source_sfreq = float(source_sfreq)
        self.ready_timeout = float(ready_timeout)
        self.server = DataServerThread(sample_rate=int(round(self.source_sfreq)), t_buffer=30.0)
        self.channel_indices: tuple[int, ...] = ()
        self.channel_names: tuple[str, ...] = ()
        self.channel_types: tuple[str, ...] = ()
        self.module_name = ""
        self._lock = threading.Lock()
        self._last_ptr_samples = 0

    def start(self) -> dict:
        not_connected = self.server.connect(hostname=self.host, port=self.port)
        if not_connected:
            raise RuntimeError(
                f"无法连接 JellyFish {self.host}:{self.port}。"
                "请确认博睿康软件已开启数据转发。"
            )
        started = time.monotonic()
        while not self.server.isReady():
            if time.monotonic() - started > self.ready_timeout:
                self.stop()
                raise RuntimeError("等待 Neuracle meta 超时，请检查转发与采样率。")
            time.sleep(0.05)
        self.server.start()
        self._configure_channels()
        return {
            "type": "hello",
            "schema_version": SCHEMA_VERSION,
            "device": "neuracle",
            "sample_rate": int(round(self.source_sfreq)),
            "channels": list(self.channel_names),
            "channel_types": list(self.channel_types),
            "module": self.module_name,
            "unit": "uV",
            "host": self.host,
            "port": self.port,
            "forwarded_channels": int(getattr(self.server, "n_chan", 0)),
        }

    def _configure_channels(self) -> None:
        source_names = tuple(str(n).strip() for n in getattr(self.server, "channelNames", ()))
        source_types = tuple(str(t).strip() for t in getattr(self.server, "channelTypes", ()))
        self.module_name = str(getattr(self.server, "moduleName", "") or "")

        if self.select_all_forwarded or (not self.requested_names and not self.select_all_eeg):
            indices = tuple(range(len(source_names)))
            names = source_names
            types = source_types if source_types else tuple("" for _ in source_names)
        elif self.select_all_eeg or not self.requested_names:
            eeg_idx = [
                i
                for i, t in enumerate(source_types)
                if not t or t.upper() == "EEG"
            ]
            if not eeg_idx:
                eeg_idx = list(range(len(source_names)))
            indices = tuple(eeg_idx)
            names = tuple(source_names[i] for i in indices)
            types = tuple(source_types[i] if i < len(source_types) else "EEG" for i in indices)
        else:
            lookup: dict[str, int] = {}
            for idx, name in enumerate(source_names):
                lookup[normalize_name(name)] = idx
            missing = [n for n in self.requested_names if normalize_name(n) not in lookup]
            if missing:
                raise RuntimeError("JellyFish 缺少通道: " + ", ".join(missing))
            indices = tuple(lookup[normalize_name(n)] for n in self.requested_names)
            names = tuple(source_names[i] for i in indices)
            types = tuple(source_types[i] if i < len(source_types) else "EEG" for i in indices)

        self.channel_indices = indices
        self.channel_names = names
        self.channel_types = types

    def poll_batch(self) -> tuple[np.ndarray, dict] | None:
        """Return new samples as float32 shape (samples, channels) in μV."""
        get_update = getattr(self.server, "GetBufferUpdateWithTiming", None)
        if callable(get_update):
            data, timing = get_update()
        else:
            data = self.server.buffer.getUpdate()
            timing = None
        if data is None or getattr(data, "size", 0) == 0:
            return None
        arr = np.asarray(data, dtype=np.float32)
        if arr.ndim != 2:
            return None
        selected = arr[np.asarray(self.channel_indices, dtype=np.int64), :]
        # (channels, samples) → (samples, channels)
        wire = np.ascontiguousarray(selected.T, dtype=np.float32)
        meta = {
            "type": "data",
            "schema_version": SCHEMA_VERSION,
            "dtype": "float32",
            "shape": [int(wire.shape[0]), int(wire.shape[1])],
            "sample_rate": int(round(self.source_sfreq)),
            "channels": list(self.channel_names),
            "unit": "uV",
            "packet_loss_count": int(getattr(self.server, "packet_loss_count", 0)),
            "packet_count": int(getattr(self.server, "packet_count", 0)),
        }
        if isinstance(timing, dict):
            meta["device_end_ms"] = timing.get("device_end_ms")
        return wire, meta

    def stop(self) -> None:
        try:
            self.server.stop()
        except Exception:
            pass


async def handle_client(websocket) -> None:  # type: ignore[no-untyped-def]
    session: NeuracleSession | None = None
    try:
        raw = await websocket.recv()
        if not isinstance(raw, str):
            await websocket.close(1003, "subscribe must be JSON")
            return
        msg = json.loads(raw)
        if not isinstance(msg, dict) or msg.get("type") != "subscribe":
            await websocket.close(1008, "invalid subscribe")
            return

        host = str(msg.get("host") or DEFAULT_JF_HOST)
        port = int(msg.get("port") or DEFAULT_JF_PORT)
        source_sfreq = float(msg.get("source_sfreq") or 250)
        mode = str(msg.get("channel_mode") or "").strip().lower()
        names = msg.get("eeg_channel_names")

        eeg_names: list[str] | None
        if mode == "all_forwarded" or names is None:
            # Every channel JellyFish forwards (typically 64: 59 EEG + ECG/EOG).
            eeg_names = None
            mode = "all_forwarded"
        elif mode == "all_eeg" or (isinstance(names, list) and len(names) == 0):
            eeg_names = []  # sentinel: EEG-typed only
            mode = "all_eeg"
        elif isinstance(names, list):
            eeg_names = [str(n) for n in names]
            mode = "named"
        else:
            await websocket.close(1008, "eeg_channel_names must be a list or null")
            return

        session = NeuracleSession(
            host=host,
            port=port,
            eeg_names=eeg_names if mode != "all_eeg" else [],
            select_all_forwarded=(mode == "all_forwarded"),
            source_sfreq=source_sfreq,
            ready_timeout=float(msg.get("ready_timeout_sec") or 15),
        )
        hello = await asyncio.to_thread(session.start)
        await websocket.send(json.dumps(hello, separators=(",", ":")))

        while True:
            batch = await asyncio.to_thread(session.poll_batch)
            if batch is None:
                await asyncio.sleep(0.02)
                continue
            wire, header = batch
            await websocket.send(json.dumps(header, separators=(",", ":")))
            await websocket.send(wire.tobytes())
    except Exception as exc:
        try:
            await websocket.send(
                json.dumps({"type": "error", "message": str(exc)}, separators=(",", ":"))
            )
        except Exception:
            pass
    finally:
        if session is not None:
            await asyncio.to_thread(session.stop)


async def main_async(ws_host: str, ws_port: int) -> None:
    from websockets.asyncio.server import serve

    async with serve(handle_client, ws_host, ws_port, max_size=16 * 1024 * 1024):
        print(f"[neuracle-bridge] ws://{ws_host}:{ws_port}/v1/stream")
        print("[neuracle-bridge] waiting for browser subscribe…")
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser(description="Neuracle JellyFish → WebSocket bridge")
    parser.add_argument("--oi-mi-root", default=None)
    parser.add_argument("--ws-host", default=DEFAULT_WS_HOST)
    parser.add_argument("--ws-port", type=int, default=DEFAULT_WS_PORT)
    args = parser.parse_args()

    oi_mi = resolve_oi_mi_root(args.oi_mi_root)
    sys.path.insert(0, str(oi_mi))
    print(f"[neuracle-bridge] using oi-mi at {oi_mi}")

    try:
        import websockets  # noqa: F401
    except ImportError:
        raise SystemExit("Missing websockets. pip install websockets") from None

    asyncio.run(main_async(args.ws_host, args.ws_port))


if __name__ == "__main__":
    main()
