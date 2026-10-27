from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from typing import Any, Mapping

from bci_dayloop.serving.task_dominance import (
    CLASS_NAMES,
    apply_prediction_dominance,
    dominant_class_index,
    parse_task_completed,
    task_completed_ack,
)

TCP_SCHEMA = "passive-bci.reve-tcp.v1"
DEFAULT_TCP_PORT = 8769
MAX_LINE_BYTES = 1_000_000
BROADCAST_TYPES = {"hello", "prediction", "feedback_ack"}


def lan_ipv4_addresses() -> list[str]:
    found: list[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if isinstance(ip, str) and not ip.startswith("127."):
            found.append(ip)
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if isinstance(ip, str) and not ip.startswith("127.") and ip not in found:
                found.append(ip)
    except OSError:
        pass
    return found


def advertised_tcp_endpoints(bind_host: str, port: int) -> list[str]:
    host = bind_host.strip() or "0.0.0.0"
    if host not in {"0.0.0.0", "::", "*"}:
        return [f"{host}:{port}"]
    return [f"{ip}:{port}" for ip in lan_ipv4_addresses()] or [f"127.0.0.1:{port}"]


def encode_line(payload: Mapping[str, Any]) -> bytes:
    return (json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def decode_line(raw: bytes | str) -> dict[str, Any]:
    text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("TCP line must be a JSON object")
    return payload


def tcp_event(payload: Mapping[str, Any], extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    event = dict(payload)
    event.setdefault("schema", TCP_SCHEMA)
    event.setdefault("t_unix", time.time())
    if extra:
        event.update(dict(extra))
    return event


def attach_follow_info(
    hello: Mapping[str, Any],
    *,
    bind_host: str,
    port: int,
) -> dict[str, Any]:
    payload = dict(hello)
    payload["follow"] = {
        "transport": "tcp-jsonl",
        "schema": TCP_SCHEMA,
        "bind": f"{bind_host}:{port}",
        "advertised": advertised_tcp_endpoints(bind_host, port),
    }
    return payload


class TcpBroadcastHub:
    """Fan-out JSONL lines to TCP clients. publish() is safe from worker threads."""

    def __init__(self) -> None:
        self._clients: set[asyncio.StreamWriter] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._hello: dict[str, Any] | None = None
        self._completed: set[int] = set()
        self._state_lock = threading.Lock()

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def set_hello(self, payload: Mapping[str, Any]) -> None:
        self._hello = dict(payload)

    def hello(self) -> dict[str, Any] | None:
        return None if self._hello is None else dict(self._hello)

    def add(self, writer: asyncio.StreamWriter) -> None:
        self._clients.add(writer)

    def discard(self, writer: asyncio.StreamWriter) -> None:
        self._clients.discard(writer)

    def client_count(self) -> int:
        return len(self._clients)

    def completed_classes(self) -> set[int]:
        with self._state_lock:
            return set(self._completed)

    def dominant_class(self) -> int | None:
        return dominant_class_index(self.completed_classes())

    def note_task_completed(self, payload: Mapping[str, Any]) -> dict[str, Any] | None:
        parsed = parse_task_completed(payload)
        if parsed is None:
            return None
        if parsed.accepted:
            with self._state_lock:
                self._completed.add(parsed.class_id)
        dominant = self.dominant_class()
        dominant_name = CLASS_NAMES[dominant] if dominant is not None else None
        print(
            "[model-service] task_completed "
            f"robot_id={parsed.robot_id} task={parsed.task} "
            f"class={parsed.class_name or parsed.class_id} "
            f"accepted={parsed.accepted} source={parsed.source} "
            f"tcp_dominant={dominant_name or '—'}",
            flush=True,
        )
        return task_completed_ack(parsed, dominant)

    def publish(self, payload: Mapping[str, Any]) -> None:
        if payload.get("type") not in BROADCAST_TYPES:
            return
        loop = self._loop
        if loop is None or not self._clients:
            return
        event = tcp_event(payload)
        if event.get("type") == "prediction":
            event = apply_prediction_dominance(event, self.dominant_class())
        line = encode_line(event)
        loop.call_soon_threadsafe(self._write_all, line)

    def _write_all(self, line: bytes) -> None:
        loop = self._loop
        for writer in list(self._clients):
            try:
                writer.write(line)
                if loop is not None:
                    loop.create_task(self._drain(writer))
            except Exception:
                self.discard(writer)
                try:
                    writer.close()
                except Exception:
                    pass

    async def _drain(self, writer: asyncio.StreamWriter) -> None:
        try:
            await writer.drain()
        except Exception:
            self.discard(writer)
            try:
                writer.close()
            except Exception:
                pass


async def handle_follow_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    hub: TcpBroadcastHub,
) -> None:
    hub.add(writer)
    hello = hub.hello()
    if hello is not None:
        writer.write(encode_line(tcp_event(hello)))
        await writer.drain()
    try:
        while True:
            raw = await reader.readline()
            if not raw:
                break
            if len(raw) > MAX_LINE_BYTES:
                break
            try:
                inbound = decode_line(raw.strip())
            except Exception:
                continue
            ack = hub.note_task_completed(inbound)
            if ack is None:
                continue
            try:
                writer.write(encode_line(tcp_event(ack)))
                await writer.drain()
            except Exception:
                break
    finally:
        hub.discard(writer)
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def start_follow_server(
    hub: TcpBroadcastHub,
    *,
    host: str,
    port: int,
) -> asyncio.AbstractServer:
    hub.attach_loop(asyncio.get_running_loop())

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await handle_follow_client(reader, writer, hub)

    return await asyncio.start_server(handler, host, port)
