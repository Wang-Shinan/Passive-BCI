from __future__ import annotations

import asyncio
from urllib.parse import urlparse

from bci_dayloop.serving.backends import ServingBackend
from bci_dayloop.serving.profiles import DeviceProfile
from bci_dayloop.serving.protocol import dumps
from bci_dayloop.serving.session import ClientSession
from bci_dayloop.serving.tcp_broadcast import (
    DEFAULT_TCP_PORT,
    TcpBroadcastHub,
    attach_follow_info,
    start_follow_server,
)

ALLOWED_PATHS = {"", "/", "/v1/model", "/v1/model/"}


def _connection_path(websocket: object) -> str:
    request = getattr(websocket, "request", None)
    path = getattr(request, "path", None) if request is not None else None
    if not isinstance(path, str) or not path:
        return "/"
    return urlparse(path).path or "/"


async def handle_model_client(
    websocket: object,
    backend: ServingBackend,
    *,
    required_profile: DeviceProfile | None = None,
    hello: dict | None = None,
    on_broadcast=None,
) -> None:
    path = _connection_path(websocket)
    if path not in ALLOWED_PATHS:
        close = getattr(websocket, "close")
        await close(1008, "unsupported path")
        return
    session = ClientSession(
        backend,
        required_profile=required_profile,
        on_broadcast=on_broadcast,
    )
    send = getattr(websocket, "send")
    try:
        from websockets.exceptions import ConnectionClosed
    except ImportError:
        ConnectionClosed = Exception  # type: ignore[misc, assignment]
    try:
        await send(dumps(hello if hello is not None else backend.hello_payload()))
        async for message in websocket:  # type: ignore[union-attr]
            replies = await asyncio.to_thread(session.handle_message, message)
            for reply in replies:
                await send(reply)
    except ConnectionClosed:
        return


async def serve_model_service(
    backend: ServingBackend,
    *,
    host: str = "127.0.0.1",
    port: int = 8768,
    required_profile: DeviceProfile | None = None,
    stop: asyncio.Event | None = None,
    tcp_host: str = "0.0.0.0",
    tcp_port: int = DEFAULT_TCP_PORT,
    tcp_enabled: bool = True,
) -> None:
    try:
        from websockets.asyncio.server import serve
    except ImportError as error:
        raise SystemExit("Missing websockets. pip install websockets") from error

    hub = TcpBroadcastHub()
    hello = backend.hello_payload()
    hub.set_hello(hello)

    tcp_server = None
    if tcp_enabled:
        try:
            tcp_server = await start_follow_server(hub, host=tcp_host, port=tcp_port)
            hello = attach_follow_info(hello, bind_host=tcp_host, port=tcp_port)
            hub.set_hello(hello)
        except OSError as error:
            print(f"[model-service] TCP follow 未能监听 {tcp_host}:{tcp_port}：{error}")
            tcp_server = None

    async def handler(websocket: object) -> None:
        await handle_model_client(
            websocket,
            backend,
            required_profile=required_profile,
            hello=hello,
            on_broadcast=hub.publish if tcp_server is not None else None,
        )

    async with serve(handler, host, port, max_size=16 * 1024 * 1024, compression=None):
        print(f"[model-service] ws://{host}:{port}/v1/model")
        if tcp_server is not None:
            endpoints = hello.get("follow", {}).get("advertised", [])
            print(f"[model-service] tcp-jsonl://{tcp_host}:{tcp_port}  (在线学习跟随，不传 EEG)")
            if endpoints:
                joined = "  ".join(f"tcp://{item}" for item in endpoints)
                print(f"[model-service] 对端连接: {joined}")
            print(
                "[model-service] 对端命令: python scripts/follow_reve_tcp.py "
                f"--host <LAN-IP> --port {tcp_port}"
            )
        print("[model-service] waiting for Passive BCI windows...")
        try:
            if stop is None:
                await asyncio.Future()
            else:
                await stop.wait()
        finally:
            if tcp_server is not None:
                tcp_server.close()
                await tcp_server.wait_closed()


def run_model_service(
    backend: ServingBackend,
    *,
    host: str = "127.0.0.1",
    port: int = 8768,
    required_profile: DeviceProfile | None = None,
    tcp_host: str = "0.0.0.0",
    tcp_port: int = DEFAULT_TCP_PORT,
    tcp_enabled: bool = True,
) -> None:
    asyncio.run(
        serve_model_service(
            backend,
            host=host,
            port=port,
            required_profile=required_profile,
            tcp_host=tcp_host,
            tcp_port=tcp_port,
            tcp_enabled=tcp_enabled,
        )
    )
