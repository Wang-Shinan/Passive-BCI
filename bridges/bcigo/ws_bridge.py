#!/usr/bin/env python3
"""BrainCo BCIGo (强脑) → WebSocket bridge for Passive BCI acquisition UI.

Uses the public [bcigo-sdk](https://pypi.org/project/bcigo-sdk/) over Wi‑Fi TCP.
Browser cannot talk to the device directly; this process discovers (mDNS) or
connects to a known host:port, starts EEG streaming, and forwards float32
batches on the same wire protocol as bridges/neuracle.

Usage:
  pip install bcigo-sdk websockets numpy
  python bridges/bcigo/ws_bridge.py
  # or: npm run bcigo-bridge

WebSocket: ws://127.0.0.1:8767/v1/stream
Subscribe (auto-discover):
  {"type":"subscribe","sample_rate":250,"gain":6,"signal":"normal"}
Subscribe (manual):
  {"type":"subscribe","host":"192.168.x.x","port":53129,"sample_rate":250}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import threading
import time
from collections import deque
from typing import Any

import numpy as np

SCHEMA_VERSION = 1
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8767
DEFAULT_N_CHANNELS = 32
DEFAULT_SAMPLE_RATE = 250

# Official 10–20 layout from bcigo-sdk docs (32 ch, last is reference).
BCIGO_CHANNEL_NAMES: tuple[str, ...] = (
    "FP1",
    "FP2",
    "F3",
    "F4",
    "F7",
    "F8",
    "Fz",
    "C3",
    "C4",
    "Cz",
    "P3",
    "P4",
    "P7",
    "P8",
    "Pz",
    "O1",
    "O2",
    "T7",
    "T8",
    "FC1",
    "FC2",
    "FC5",
    "FC6",
    "CP1",
    "CP2",
    "CP5",
    "CP6",
    "FT9",
    "FT10",
    "TP9",
    "TP10",
    "IO",
)


def _gain_enum(sdk: Any, gain: int) -> Any:
    mapping = {
        1: sdk.EegSignalGain.GAIN_1,
        2: sdk.EegSignalGain.GAIN_2,
        4: sdk.EegSignalGain.GAIN_4,
        6: sdk.EegSignalGain.GAIN_6,
        8: sdk.EegSignalGain.GAIN_8,
        12: sdk.EegSignalGain.GAIN_12,
        24: sdk.EegSignalGain.GAIN_24,
    }
    return mapping.get(int(gain), sdk.EegSignalGain.GAIN_6)


def _fs_enum(sdk: Any, fs: int) -> Any:
    mapping = {
        250: sdk.EegSampleRate.SR_250Hz,
        500: sdk.EegSampleRate.SR_500Hz,
        1000: sdk.EegSampleRate.SR_1000Hz,
        2000: sdk.EegSampleRate.SR_2000Hz,
    }
    return mapping.get(int(fs), sdk.EegSampleRate.SR_250Hz)


def _signal_enum(sdk: Any, name: str) -> Any:
    key = (name or "normal").strip().lower()
    mapping = {
        "normal": sdk.EegSignalSource.NORMAL,
        "test": sdk.EegSignalSource.TEST_SIGNAL,
        "test_signal": sdk.EegSignalSource.TEST_SIGNAL,
        "shorted": sdk.EegSignalSource.SHORTED,
        "mvdd": sdk.EegSignalSource.MVDD,
    }
    return mapping.get(key, sdk.EegSignalSource.NORMAL)


def _msg_type(sdk: Any, name: str) -> Any:
    key = (name or "BCIGo").strip()
    return getattr(sdk.MsgType, key, sdk.MsgType.BCIGo)


def _strip_index_column(arr: np.ndarray, n_channels: int) -> np.ndarray:
    """BCIGo get_eeg_buffer rows are [sample_index, ch0..ch31] → width 33."""
    if arr.ndim != 2 or arr.shape[1] == 0:
        return arr
    if n_channels > 0 and arr.shape[1] == n_channels + 1:
        return arr[:, 1:]
    # Heuristic: first col looks like a monotonic counter, rest are EEG-width.
    if arr.shape[1] > n_channels >= 1:
        col0 = arr[:, 0]
        if np.all(np.isfinite(col0)) and np.nanmax(np.abs(col0)) < 1e5:
            if arr.shape[1] - 1 == n_channels:
                return arr[:, 1:]
    return arr


def _coerce_eeg_raw(raw: Any) -> Any:
    """SDK callback may deliver dict / nested list; flatten to array-like."""
    if raw is None:
        return None
    if isinstance(raw, dict):
        for key in ("data", "eeg", "values", "samples", "payload", "buffer"):
            if key in raw:
                return _coerce_eeg_raw(raw[key])
        # Numeric dict values only
        vals = list(raw.values())
        if vals and all(isinstance(v, (int, float, np.floating, np.integer)) for v in vals):
            return vals
        # dict of channel → series
        if vals and all(isinstance(v, (list, tuple, np.ndarray)) for v in vals):
            try:
                return np.asarray(vals, dtype=np.float32).T
            except Exception:
                return None
        return None
    if isinstance(raw, (list, tuple)) and raw and isinstance(raw[0], dict):
        rows = []
        for item in raw:
            coerced = _coerce_eeg_raw(item)
            if coerced is None:
                continue
            rows.append(np.asarray(coerced, dtype=np.float32).ravel())
        if not rows:
            return None
        return np.stack(rows, axis=0)
    return raw


def normalize_eeg_batch(raw: Any, n_channels: int) -> np.ndarray | None:
    """Return contiguous float32 (samples, channels) from SDK buffer (μV-scale)."""
    raw = _coerce_eeg_raw(raw)
    if raw is None:
        return None
    try:
        arr = np.asarray(raw, dtype=np.float32)
    except (TypeError, ValueError):
        return None
    if arr.size == 0:
        return None
    if arr.ndim == 1:
        width = n_channels + 1 if n_channels > 0 else 0
        if width and arr.size % width == 0:
            arr = arr.reshape(-1, width)
            return np.ascontiguousarray(_strip_index_column(arr, n_channels))
        if n_channels > 0 and arr.size % n_channels == 0:
            return np.ascontiguousarray(arr.reshape(-1, n_channels))
        return np.ascontiguousarray(arr.reshape(1, -1))
    if arr.ndim == 2:
        # Prefer (samples, channels); transpose if channels-first.
        if arr.shape[0] == n_channels and arr.shape[1] != n_channels:
            arr = arr.T
        elif arr.shape[0] == n_channels + 1 and arr.shape[1] != n_channels + 1:
            arr = arr.T
        arr = _strip_index_column(arr, n_channels)
        return np.ascontiguousarray(arr)
    # Nested lists of per-sample vectors
    try:
        stacked = np.asarray([np.asarray(row, dtype=np.float32).ravel() for row in raw], dtype=np.float32)
        if stacked.ndim == 2:
            stacked = _strip_index_column(stacked, n_channels)
            return np.ascontiguousarray(stacked)
    except Exception:
        return None
    return None


class BciGoSession:
    def __init__(
        self,
        host: str | None,
        port: int | None,
        sample_rate: int,
        gain: int,
        signal: str,
        msg_type_name: str,
        n_channels: int,
        ready_timeout: float,
        channel_names: list[str] | None,
    ) -> None:
        self.host = (host or "").strip() or None
        self.port = int(port) if port else None
        self.sample_rate = int(sample_rate)
        self.gain = int(gain)
        self.signal = signal
        self.msg_type_name = msg_type_name
        self.n_channels = int(n_channels)
        self.ready_timeout = float(ready_timeout)
        self.channel_names = tuple(channel_names) if channel_names else BCIGO_CHANNEL_NAMES[: self.n_channels]
        if len(self.channel_names) != self.n_channels:
            # Pad / truncate to n_channels
            names = list(self.channel_names)
            while len(names) < self.n_channels:
                names.append(f"Ch{len(names) + 1}")
            self.channel_names = tuple(names[: self.n_channels])

        self._sdk: Any = None
        self._client: Any = None
        self._lock = threading.Lock()
        self._queue: deque[np.ndarray] = deque(maxlen=256)
        self._packet_count = 0
        self._started = False
        self._impedance_mode = False
        self._imp_latest: np.ndarray | None = None
        self._imp_packet = 0
        self.resolved_host = ""
        self.resolved_port = 0

    def _on_eeg(self, data: Any) -> None:
        try:
            batch = normalize_eeg_batch(data, self.n_channels)
            if batch is None:
                return
            with self._lock:
                self._queue.append(batch)
                self._packet_count += 1
        except Exception:
            # Never raise into the SDK thread — that can stall the stream.
            return

    def _on_imp(self, data: Any) -> None:
        try:
            arr = np.asarray(data, dtype=np.float32).ravel()
            if arr.size == 0:
                return
            with self._lock:
                self._imp_latest = arr
                self._imp_packet += 1
        except Exception:
            return

    async def start(self) -> dict:
        import bcigo_sdk as sdk

        self._sdk = sdk
        sdk.clear_eeg_buffer()
        sdk.set_eeg_data_callback(self._on_eeg)
        try:
            sdk.set_imp_data_callback(self._on_imp)
        except Exception:
            pass

        if self.host and self.port:
            addr, port = self.host, self.port
        else:
            try:
                found = await asyncio.wait_for(sdk.mdns_start_scan(), timeout=12.0)
            except asyncio.TimeoutError as exc:
                raise RuntimeError(
                    "mDNS 扫描超时。请确认设备已上电并与电脑同一 Wi‑Fi，或填写 host/port。"
                ) from exc
            except Exception as exc:
                raise RuntimeError(
                    f"mDNS 未发现强脑设备：{exc}。请确认已连同一 Wi‑Fi，或填写 host/port。"
                ) from exc
            if not found:
                raise RuntimeError("mDNS 未发现强脑设备。请确认耳机/帽已上电并连同一 Wi‑Fi，或填写 host/port。")
            addr, port = found[0], int(found[1])

        self.resolved_host = str(addr)
        self.resolved_port = int(port)
        self._client = sdk.BCIGoClient(str(addr), int(port))
        parser = sdk.MessageParser("bcigo", _msg_type(sdk, self.msg_type_name))

        # Device only accepts one TCP client; hang here = App / stale bridge holding it.
        try:
            await asyncio.wait_for(
                self._client.start_stream(
                    parser,
                    fs=_fs_enum(sdk, self.sample_rate),
                    gain=_gain_enum(sdk, self.gain),
                    signal=_signal_enum(sdk, self.signal),
                ),
                timeout=15.0,
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"连接设备 TCP 超时（{self.resolved_host}:{self.resolved_port}）。"
                "请关闭强脑官方 App，并确认没有其它桥接占用设备后重试。"
            ) from exc
        self._started = True

        # Peek once for data_ready — do NOT block hello on first samples.
        saw = False
        peek_deadline = time.monotonic() + min(0.4, max(0.0, self.ready_timeout))
        while time.monotonic() < peek_deadline:
            batch = self.poll_batch()
            if batch is not None:
                wire, _ = batch
                with self._lock:
                    self._queue.appendleft(wire)
                saw = True
                break
            await asyncio.sleep(0.05)

        return {
            "type": "hello",
            "schema_version": SCHEMA_VERSION,
            "device": "bcigo",
            "sample_rate": self.sample_rate,
            "channels": list(self.channel_names),
            "channel_types": ["EEG"] * self.n_channels,
            "module": f"BCIGo@{self.resolved_host}:{self.resolved_port}",
            "unit": "uV",
            "host": self.resolved_host,
            "port": self.resolved_port,
            "forwarded_channels": self.n_channels,
            "gain": self.gain,
            "signal": self.signal,
            "data_ready": saw,
            "supports_impedance": True,
        }

    async def start_impedance(self) -> dict:
        sdk = self._sdk
        client = self._client
        if sdk is None or client is None:
            raise RuntimeError("设备未连接")
        # Clear EEG queue; switch mode
        with self._lock:
            self._queue.clear()
            self._imp_latest = None
        try:
            sdk.clear_imp_eeg_buffers()
        except Exception:
            pass
        await client.enable_impedance_detection_mode(
            loop_check=True,
            freq=sdk.LeadOffFreq.Ac31p2hz,
            current=sdk.LeadOffCurrent.Cur6nA,
        )
        self._impedance_mode = True
        return {
            "type": "impedance_status",
            "active": True,
            "message": "已进入阻抗检测模式",
            "channels": list(self.channel_names),
        }

    async def stop_impedance(self) -> dict:
        client = self._client
        if client is None:
            raise RuntimeError("设备未连接")
        try:
            await client.disable_impedance_detection_mode()
        except Exception as exc:
            # Still mark inactive so UI can resume EEG expectation
            self._impedance_mode = False
            raise RuntimeError(f"退出阻抗模式失败：{exc}") from exc
        self._impedance_mode = False
        with self._lock:
            self._queue.clear()
        return {
            "type": "impedance_status",
            "active": False,
            "message": "已退出阻抗检测，恢复 EEG",
        }

    def poll_impedance(self) -> dict | None:
        with self._lock:
            if self._imp_latest is None:
                return None
            vals = self._imp_latest.astype(np.float32).copy()
            pkt = self._imp_packet
        # Pad / trim to channel count
        out = np.full(self.n_channels, np.nan, dtype=np.float32)
        n = min(self.n_channels, vals.size)
        out[:n] = vals[:n]
        return {
            "type": "impedance",
            "schema_version": SCHEMA_VERSION,
            "channels": list(self.channel_names),
            "values_kohm": [None if not np.isfinite(v) else float(v) for v in out],
            "packet_count": int(pkt),
            "unit": "kOhm",
        }

    def poll_batch(self) -> tuple[np.ndarray, dict] | None:
        if self._impedance_mode:
            return None
        sdk = self._sdk
        chunks: list[np.ndarray] = []

        with self._lock:
            while self._queue:
                chunks.append(self._queue.popleft())

        if sdk is not None:
            try:
                buf = sdk.get_eeg_buffer(True, True)
            except Exception:
                buf = None
            batch = normalize_eeg_batch(buf, self.n_channels)
            if batch is not None:
                chunks.append(batch)
                with self._lock:
                    self._packet_count += 1

        if not chunks:
            return None

        wire = np.ascontiguousarray(np.concatenate(chunks, axis=0), dtype=np.float32)
        # Hot-fix channel count if SDK reports a different width
        if wire.shape[1] != self.n_channels and wire.shape[1] > 0:
            self.n_channels = int(wire.shape[1])
            names = list(BCIGO_CHANNEL_NAMES)
            while len(names) < self.n_channels:
                names.append(f"Ch{len(names) + 1}")
            self.channel_names = tuple(names[: self.n_channels])

        with self._lock:
            pkt = self._packet_count

        meta = {
            "type": "data",
            "schema_version": SCHEMA_VERSION,
            "dtype": "float32",
            "shape": [int(wire.shape[0]), int(wire.shape[1])],
            "sample_rate": self.sample_rate,
            "channels": list(self.channel_names),
            "unit": "uV",
            "packet_loss_count": 0,
            "packet_count": int(pkt),
        }
        return wire, meta

    async def stop(self) -> None:
        sdk = self._sdk
        client = self._client
        try:
            if self._impedance_mode and client is not None:
                try:
                    await client.disable_impedance_detection_mode()
                except Exception:
                    pass
                self._impedance_mode = False
            if sdk is not None:
                try:
                    sdk.set_eeg_data_callback(None)
                except Exception:
                    pass
                try:
                    sdk.set_imp_data_callback(None)
                except Exception:
                    pass
                try:
                    sdk.clear_eeg_buffer()
                except Exception:
                    pass
            if client is not None and self._started:
                try:
                    await client.stop_eeg_stream()
                except Exception:
                    pass
                try:
                    await client.disconnect_tcp()
                except Exception:
                    pass
        finally:
            self._client = None
            self._started = False


# Only one browser client may hold the device TCP socket at a time.
_active_lock = asyncio.Lock()
_active_session: BciGoSession | None = None


async def _release_active_session() -> None:
    global _active_session
    async with _active_lock:
        prev = _active_session
        _active_session = None
    if prev is not None:
        try:
            await prev.stop()
        except Exception:
            pass


async def handle_client(websocket) -> None:  # type: ignore[no-untyped-def]
    global _active_session
    session: BciGoSession | None = None
    try:
        raw = await websocket.recv()
        if not isinstance(raw, str):
            await websocket.close(1003, "subscribe must be JSON")
            return
        msg = json.loads(raw)
        if not isinstance(msg, dict) or msg.get("type") != "subscribe":
            await websocket.close(1008, "invalid subscribe")
            return

        await websocket.send(
            json.dumps(
                {
                    "type": "status",
                    "message": "正在连接强脑设备（mDNS / TCP）…",
                },
                separators=(",", ":"),
            )
        )

        # Drop any previous device hold so reconnect doesn't sit on TCP timeout.
        await _release_active_session()

        host = msg.get("host")
        port = msg.get("port")
        names = msg.get("eeg_channel_names")
        channel_names: list[str] | None
        if isinstance(names, list) and names:
            channel_names = [str(n) for n in names]
            n_ch = len(channel_names)
        else:
            channel_names = None
            n_ch = int(msg.get("n_channels") or DEFAULT_N_CHANNELS)

        session = BciGoSession(
            host=str(host) if host else None,
            port=int(port) if port else None,
            sample_rate=int(msg.get("sample_rate") or msg.get("source_sfreq") or DEFAULT_SAMPLE_RATE),
            gain=int(msg.get("gain") or 6),
            signal=str(msg.get("signal") or "normal"),
            msg_type_name=str(msg.get("msg_type") or "BCIGo"),
            n_channels=n_ch,
            ready_timeout=float(msg.get("ready_timeout_sec") or 8),
            channel_names=channel_names,
        )
        async with _active_lock:
            _active_session = session
        hello = await session.start()
        await websocket.send(json.dumps(hello, separators=(",", ":")))

        if not hello.get("data_ready"):
            await websocket.send(
                json.dumps(
                    {
                        "type": "status",
                        "message": (
                            f"已连上 {hello['host']}:{hello['port']}，但尚未收到 EEG 样本。"
                            "请关闭强脑官方 App 独占连接后重试，或确认设备已开始采集。"
                        ),
                    },
                    separators=(",", ":"),
                )
            )

        idle_since = time.monotonic()
        while True:
            # Non-blocking command poll
            try:
                cmd_raw = await asyncio.wait_for(websocket.recv(), timeout=0.02)
            except asyncio.TimeoutError:
                cmd_raw = None
            except Exception:
                break

            if isinstance(cmd_raw, str):
                try:
                    cmd = json.loads(cmd_raw)
                except Exception:
                    cmd = None
                if isinstance(cmd, dict):
                    ctype = str(cmd.get("type") or "")
                    try:
                        if ctype == "impedance_start":
                            status = await session.start_impedance()
                            await websocket.send(json.dumps(status, separators=(",", ":")))
                        elif ctype == "impedance_stop":
                            status = await session.stop_impedance()
                            await websocket.send(json.dumps(status, separators=(",", ":")))
                        elif ctype == "ping":
                            await websocket.send(json.dumps({"type": "pong"}, separators=(",", ":")))
                    except Exception as exc:
                        await websocket.send(
                            json.dumps(
                                {"type": "error", "message": str(exc)},
                                separators=(",", ":"),
                            )
                        )

            if session._impedance_mode:  # noqa: SLF001 — bridge-local
                imp = session.poll_impedance()
                if imp is not None:
                    await websocket.send(json.dumps(imp, separators=(",", ":")))
                    idle_since = time.monotonic()
                elif time.monotonic() - idle_since > 8:
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "status",
                                "message": "阻抗模式中，等待 Lead-Off 回调…",
                            },
                            separators=(",", ":"),
                        )
                    )
                    idle_since = time.monotonic()
                continue

            batch = session.poll_batch()
            if batch is None:
                if time.monotonic() - idle_since > 30:
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "status",
                                "message": "等待 EEG 数据…（若长时间无波形，请检查官方 App 是否占用设备）",
                            },
                            separators=(",", ":"),
                        )
                    )
                    idle_since = time.monotonic()
                continue
            idle_since = time.monotonic()
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
            async with _active_lock:
                if _active_session is session:
                    _active_session = None
            await session.stop()


async def main_async(ws_host: str, ws_port: int) -> None:
    from websockets.asyncio.server import serve

    async with serve(handle_client, ws_host, ws_port, max_size=16 * 1024 * 1024):
        print(f"[bcigo-bridge] ws://{ws_host}:{ws_port}/v1/stream")
        print("[bcigo-bridge] waiting for browser subscribe…")
        print("[bcigo-bridge] tip: pip install 'bcigo-sdk' websockets numpy")
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser(description="BrainCo BCIGo → WebSocket bridge")
    parser.add_argument("--ws-host", default=DEFAULT_WS_HOST)
    parser.add_argument("--ws-port", type=int, default=DEFAULT_WS_PORT)
    args = parser.parse_args()

    try:
        import bcigo_sdk  # noqa: F401
    except ImportError:
        raise SystemExit("Missing bcigo-sdk. pip install bcigo-sdk") from None
    try:
        import websockets  # noqa: F401
    except ImportError:
        raise SystemExit("Missing websockets. pip install websockets") from None

    asyncio.run(main_async(args.ws_host, args.ws_port))


if __name__ == "__main__":
    main()
