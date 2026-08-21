#!/usr/bin/env python3
"""Neuracle/JellyFish → WebSocket bridge for Passive BCI acquisition UI.

Reuses oi-mi's `collect.neuracle_api.DataServerThread` (博睿康转发协议).

Usage:
  OI_MI_ROOT=/path/to/oi-mi python bridges/neuracle/ws_bridge.py
  # default OI_MI_ROOT: ../../oi-mi next to Passive BCI, or ~/Documents/oi-mi

WebSocket: ws://127.0.0.1:8766/v1/stream
Subscribe: {"type":"subscribe","host":"127.0.0.1",  # omit host/port to auto-detect
            "source_sfreq":1000,
            "eeg_channel_names":["Fpz","Fp1",...]}  # optional; omit = all EEG
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np

SCHEMA_VERSION = 1
DEFAULT_WS_HOST = "127.0.0.1"
DEFAULT_WS_PORT = 8766
DEFAULT_JF_HOST = "127.0.0.1"
DEFAULT_JF_PORT = 8712
DEFAULT_SOURCE_SFREQ = 1000
FORWARD_PORT_LO = 8700
FORWARD_PORT_HI = 8730
FORWARD_HINT = (
    "请在实验采集界面菜单栏点「数据转发」（不要只勾实验设置里的 LSL），"
    "选探头后再点「开始」。端口会自动探测，不必手填。"
)


def collect_running() -> bool:
    return bool(jellyfish_pids())


def diagnose_forward(host: str, port: int) -> str:
    listening = tcp_open(host, port)
    running = collect_running()
    owned = jellyfish_listen_ports()
    if listening:
        return f"{host}:{port} 已在监听。"
    if owned:
        shown = ", ".join(str(p) for p in owned)
        return f"Collect 正在听 {shown}，但 {host}:{port} 不通。"
    if running:
        return (
            "Collect/JellyFish 已打开，但还没有任何 TCP 转发口。"
            "刚才若只勾了 LSL，那是另一条流；请在采集界面点「数据转发」→ 选探头 →「开始」。"
        )
    return "未发现 Collect 进程，也没有可连的转发口。请先打开 Collect 并开始实验。"

DataServerThread = None  # set in main() after import_data_server()

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


def _oi_mi_candidates(explicit: str | None) -> list[Path]:
    here = Path(__file__).resolve()
    raw = [
        explicit,
        os.environ.get("OI_MI_ROOT"),
        here.parents[2].parent / "oi-mi",
        Path.home() / "Documents" / "oi-mi",
    ]
    out: list[Path] = []
    seen: set[Path] = set()
    for item in raw:
        if not item:
            continue
        path = Path(item).expanduser().resolve()
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out


def _ncc_src_candidates() -> list[Path]:
    here = Path(__file__).resolve()
    raw = [
        os.environ.get("NCC_OI_BCI_SRC"),
        here.parents[2].parent / "NCC-OI-BCI" / "src",
        Path.home() / "Desktop" / "NCC-OI-BCI" / "src",
    ]
    out: list[Path] = []
    seen: set[Path] = set()
    for item in raw:
        if not item:
            continue
        path = Path(item).expanduser().resolve()
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out


def _ensure_optional_edf_stub() -> None:
    """neuracle_api imports pyedflib only for BDF save; live TCP does not need it."""
    try:
        import pyedflib  # noqa: F401
        return
    except ImportError:
        pass
    import types

    fake = types.ModuleType("pyedflib")
    fake.highlevel = types.SimpleNamespace(
        make_signal_header=lambda *args, **kwargs: None,
        make_header=lambda *args, **kwargs: {"annotations": []},
        write_edf=lambda *args, **kwargs: None,
    )
    sys.modules.setdefault("pyedflib", fake)


def import_data_server(explicit_oi_mi: str | None):
    """Load official DataServerThread from oi-mi, or the NCC vendor copy."""
    _ensure_optional_edf_stub()
    for root in _oi_mi_candidates(explicit_oi_mi):
        api = root / "collect" / "neuracle_api.py"
        if not api.is_file():
            continue
        sys.path.insert(0, str(root))
        from collect.neuracle_api import DataServerThread  # type: ignore

        print(f"[neuracle-bridge] using oi-mi at {root}")
        return DataServerThread

    for src in _ncc_src_candidates():
        api = src / "bci_dayloop" / "vendor" / "neuracle" / "neuracle_api.py"
        if not api.is_file():
            continue
        sys.path.insert(0, str(src))
        from bci_dayloop.vendor.neuracle.neuracle_api import DataServerThread  # type: ignore

        print(f"[neuracle-bridge] using NCC vendor neuracle_api at {src}")
        return DataServerThread

    raise SystemExit(
        "找不到博睿康 DataServerThread。请设置 OI_MI_ROOT（需含 collect/neuracle_api.py），"
        "或把 NCC-OI-BCI 放在与 Passive-BCI 同级目录。"
    )


def normalize_name(name: str) -> str:
    return "".join(str(name).split()).upper()


def local_ipv4s() -> list[str]:
    ips: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return ips


def tcp_open(host: str, port: int, timeout: float = 0.2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def jellyfish_pids() -> list[int]:
    if sys.platform != "win32":
        return []
    try:
        import subprocess

        out = subprocess.check_output(
            [
                "tasklist",
                "/FI",
                "IMAGENAME eq Neuracle.JellyFish.View.Main.exe",
                "/FO",
                "CSV",
                "/NH",
            ],
            text=True,
            timeout=4,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []
    pids: list[int] = []
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split(",")]
        if len(parts) < 2 or "JellyFish" not in parts[0]:
            continue
        try:
            pids.append(int(parts[1]))
        except ValueError:
            continue
    return pids


def jellyfish_listen_ports() -> list[int]:
    pids = set(jellyfish_pids())
    if not pids:
        return []
    try:
        import subprocess

        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "TCP"],
            text=True,
            timeout=4,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []
    ports: list[int] = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP" or parts[3].upper() != "LISTENING":
            continue
        try:
            pid = int(parts[4])
            port = int(parts[1].rsplit(":", 1)[-1])
        except ValueError:
            continue
        if pid in pids and port not in ports:
            ports.append(port)
    return ports


def collect_config_ports() -> list[int]:
    ports: list[int] = []
    here = Path(__file__).resolve()
    candidates = [
        Path(r"D:\Programs\Collect\Conf\SystemSetting.json"),
        Path(r"C:\Programs\Collect\Conf\SystemSetting.json"),
        here.parents[2].parent / "Collect" / "Conf" / "SystemSetting.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for key in ("DataTransferPort", "DataServicePort"):
            try:
                port = int(data.get(key) or 0)
            except (TypeError, ValueError):
                continue
            if 1 <= port <= 65535 and port not in ports:
                ports.append(port)
    return ports


def scan_ports(host: str, ports: list[int], timeout: float = 0.2) -> int | None:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not ports:
        return None
    with ThreadPoolExecutor(max_workers=min(16, len(ports))) as pool:
        futs = {pool.submit(tcp_open, host, port, timeout): port for port in ports}
        for fut in as_completed(futs):
            if fut.result():
                return futs[fut]
    return None


def auto_ports() -> list[int]:
    ports: list[int] = []
    for port in [*jellyfish_listen_ports(), *collect_config_ports(), *range(FORWARD_PORT_LO, FORWARD_PORT_HI + 1), 4097]:
        if port not in ports:
            ports.append(port)
    return ports


def resolve_forward_endpoint(host: str | None, port: int | None) -> tuple[str, int]:
    hosts = [host] if host else [DEFAULT_JF_HOST, *local_ipv4s()]
    if port:
        for h in hosts:
            if tcp_open(h, port):
                print(f"[neuracle-bridge] using {h}:{port}")
                return h, port
        return hosts[0], port

    owned = jellyfish_listen_ports()
    if owned:
        print(f"[neuracle-bridge] JellyFish listening on {owned}")
        return hosts[0], owned[0]

    for h in hosts:
        found = scan_ports(h, auto_ports())
        if found is not None:
            print(f"[neuracle-bridge] discovered forwarder {h}:{found}")
            return h, found
    return hosts[0], (collect_config_ports()[0] if collect_config_ports() else DEFAULT_JF_PORT)


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
        if DataServerThread is None:
            raise RuntimeError("DataServerThread 尚未加载")

        self.host = host
        self.port = port
        self.requested_names = tuple(eeg_names) if eeg_names else ()
        self.select_all_forwarded = bool(select_all_forwarded)
        self.select_all_eeg = (not select_all_forwarded) and eeg_names is not None and len(eeg_names) == 0
        self.source_sfreq = float(source_sfreq)
        self.ready_timeout = float(ready_timeout)
        # t_buffer only sizes the ring; live latency is packet assembly + poll.
        self.server = DataServerThread(sample_rate=int(round(self.source_sfreq)), t_buffer=2.0)
        self._tune_low_latency()
        self.channel_indices: tuple[int, ...] = ()
        self.channel_names: tuple[str, ...] = ()
        self.channel_types: tuple[str, ...] = ()
        self.module_name = ""
        self._lock = threading.Lock()
        self._last_ptr_samples = 0
        self._logged_batch = False

    def _tune_low_latency(self) -> None:
        """Vendor default waits for 20 × ~5 ms packets (~100 ms) before emit."""
        raw = os.environ.get("NEURACLE_ASSEMBLE_PACKETS", "1")
        try:
            n = int(raw)
        except ValueError:
            n = 1
        n = max(1, min(n, 20))
        try:
            self.server.max_single_packet = n
        except Exception:
            pass
        print(f"[neuracle-bridge] max_single_packet={n} (1 = lowest latency)")

    def start(self) -> dict:
        not_connected = self.server.connect(hostname=self.host, port=self.port)
        if not_connected:
            raise RuntimeError(
                f"无法连接 Collect 数据转发 {self.host}:{self.port}。"
                f"{diagnose_forward(self.host, self.port)}{FORWARD_HINT}"
            )
        started = time.monotonic()
        while not self.server.isReady():
            self._adopt_meta_sample_rate()
            if time.monotonic() - started > self.ready_timeout:
                self.stop()
                raise RuntimeError(
                    f"已连上 {self.host}:{self.port}，但 META/稳定数据包未就绪。"
                    f"{FORWARD_HINT}"
                    "采样率须与设备一致（现场 64 导常见 1000 Hz）。"
                )
            time.sleep(0.05)
        self.server.start()
        self._adopt_meta_sample_rate()
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

    def _adopt_meta_sample_rate(self) -> None:
        """Prefer per-channel sampleRates from META over the subscribe guess."""
        rates: list[float] = []
        for value in getattr(self.server, "srates", ()) or ():
            try:
                rate = float(value)
            except (TypeError, ValueError):
                continue
            if rate > 0:
                rates.append(rate)
        if not rates:
            return
        adopted = rates[0]
        if abs(adopted - self.source_sfreq) >= 1:
            print(
                f"[neuracle-bridge] META sample rate {adopted:g} Hz "
                f"(subscribe was {self.source_sfreq:g} Hz)"
            )
        self.source_sfreq = adopted
        try:
            self.server.sample_rate = int(round(adopted))
        except Exception:
            pass

    def _read_update(self) -> tuple[np.ndarray, dict] | None:
        """Return (channels, samples) plus optional timing from the vendor buffer."""
        get_update = getattr(self.server, "GetBufferUpdateWithTiming", None)
        if callable(get_update):
            data, timing = get_update()
            if data is None or getattr(data, "size", 0) == 0:
                return None
            extra = timing if isinstance(timing, dict) else {}
            return np.asarray(data, dtype=np.float32), extra

        get_packet = getattr(self.server, "getUpdatePacket", None)
        if callable(get_packet):
            item = get_packet()
            if not isinstance(item, dict):
                return None
            samples = item.get("samples")
            if samples is None or getattr(samples, "size", 0) == 0:
                return None
            extra: dict = {}
            start = item.get("startTimeStamp")
            length = item.get("timeStampLength")
            if isinstance(start, (int, float)) and start == start:
                extra["device_start_ms"] = float(start)
                if isinstance(length, (int, float)) and length == length:
                    extra["device_end_ms"] = float(start) + float(length)
            arrival = item.get("hostReceivedAtMonotonic")
            if isinstance(arrival, (int, float)) and arrival == arrival:
                extra["arrival_monotonic"] = float(arrival)
            return np.asarray(samples, dtype=np.float32), extra

        data = self.server.buffer.getUpdate()
        if data is None or getattr(data, "size", 0) == 0:
            return None
        return np.asarray(data, dtype=np.float32), {}

    def poll_batch(self) -> tuple[np.ndarray, dict] | None:
        """Return new samples as float32 shape (samples, channels) in μV."""
        update = self._read_update()
        if update is None:
            return None
        arr, timing = update
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
            for key, caster in (
                ("device_start_ms", float),
                ("device_end_ms", float),
                ("arrival_monotonic", float),
                ("total_samples", int),
            ):
                val = timing.get(key)
                if isinstance(val, (int, float)) and val == val:
                    meta[key] = caster(val)
        if not self._logged_batch:
            self._logged_batch = True
            ms = 1000.0 * wire.shape[0] / max(1.0, self.source_sfreq)
            print(
                f"[neuracle-bridge] first batch {wire.shape[0]} samples "
                f"({ms:.0f} ms) × {wire.shape[1]} ch @ {self.source_sfreq:g} Hz"
            )
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

        raw_host = str(msg.get("host") or "").strip()
        raw_port = msg.get("port")
        try:
            port_hint = int(raw_port) if raw_port not in (None, "", 0, "0") else None
        except (TypeError, ValueError):
            port_hint = None
        host, port = resolve_forward_endpoint(raw_host or None, port_hint)
        source_sfreq = float(msg.get("source_sfreq") or DEFAULT_SOURCE_SFREQ)
        if source_sfreq <= 0:
            source_sfreq = DEFAULT_SOURCE_SFREQ
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
            ready_timeout=float(msg.get("ready_timeout_sec") or 20),
        )
        hello = await asyncio.to_thread(session.start)
        await websocket.send(json.dumps(hello, separators=(",", ":")))

        # Keep polling the SDK even if the browser is slow to read WS.
        # Otherwise Collect's packet queue overflows and dumps the buffer.
        pending: deque[tuple[np.ndarray, dict]] = deque(maxlen=48)
        dropped = 0
        while True:
            while True:
                nxt = session.poll_batch()
                if nxt is None:
                    break
                if len(pending) == pending.maxlen:
                    pending.popleft()
                    dropped += 1
                    if dropped == 1 or dropped % 50 == 0:
                        print(
                            f"[neuracle-bridge] ws backpressure, dropped {dropped} packets",
                            flush=True,
                        )
                pending.append(nxt)
            if not pending:
                await asyncio.sleep(0.001)
                continue
            wire, header = pending.popleft()
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

    global DataServerThread
    DataServerThread = import_data_server(args.oi_mi_root)

    try:
        import websockets  # noqa: F401
    except ImportError:
        raise SystemExit("Missing websockets. pip install websockets") from None

    asyncio.run(main_async(args.ws_host, args.ws_port))


if __name__ == "__main__":
    main()
