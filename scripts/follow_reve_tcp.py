#!/usr/bin/env python3
"""另一台电脑用的 REVE 在线学习接收脚本（只需这一份文件）。

协议：实验机 REVE 在 TCP 8769 上推送 JSON 行（hello / prediction / feedback_ack）。
不传原始 EEG。Python 3.8+ 标准库即可，不必克隆仓库。

用法：
  python follow_reve_tcp.py --host 192.168.1.8
  python follow_reve_tcp.py --host 192.168.1.8 --port 8769

终端会打印预测；浏览器打开脚本打印的本地地址可看实时条。
Ctrl+C 退出。
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

DEFAULT_PORT = 8769
DEFAULT_HTTP_PORT = 8770
HISTORY = 24

_lock = threading.Lock()
_hello: dict[str, Any] | None = None
_prediction: dict[str, Any] | None = None
_acks: deque[dict[str, Any]] = deque(maxlen=HISTORY)
_status = "未连接"
_clients: list[Any] = []


def _model_field(payload: dict[str, Any], key: str, default: Any = None) -> Any:
    model = payload.get("model")
    if isinstance(model, dict) and key in model:
        return model.get(key)
    return payload.get(key, default)


def _revision(payload: dict[str, Any]) -> str:
    online = payload.get("online")
    if isinstance(online, dict) and isinstance(online.get("model_revision"), str):
        return online["model_revision"]
    value = payload.get("model_revision")
    return value if isinstance(value, str) else "—"


def _class_names(hello: dict[str, Any] | None, prediction: dict[str, Any] | None) -> list[str]:
    for payload in (prediction, hello):
        if not payload:
            continue
        names = _model_field(payload, "class_names")
        if isinstance(names, list):
            return [str(name) for name in names]
    return []


def _print_event(payload: dict[str, Any]) -> None:
    kind = payload.get("type", "?")
    if kind == "hello":
        names = _class_names(payload, None)
        print(
            f"[hello] task={_model_field(payload, 'task')} "
            f"classes={names} revision={_revision(payload)}",
            flush=True,
        )
        return
    if kind == "prediction":
        names = payload.get("class_names") or []
        probs = payload.get("probabilities") or []
        pretty = " ".join(
            f"{name}={float(prob):.0%}"
            for name, prob in zip(names, probs)
        )
        print(
            f"[pred] {payload.get('class_name')} "
            f"{float(payload.get('confidence') or 0) * 100:.0f}% "
            f"step={payload.get('online_update_step')} {pretty}",
            flush=True,
        )
        return
    if kind == "feedback_ack":
        print(
            f"[ack] accepted={payload.get('accepted')} "
            f"label={payload.get('label')} "
            f"step={payload.get('online_update_step')} "
            f"rev={payload.get('model_revision')}",
            flush=True,
        )
        return
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _snapshot() -> dict[str, Any]:
    with _lock:
        return {
            "status": _status,
            "hello": _hello,
            "prediction": _prediction,
            "acks": list(_acks),
        }


def _apply_event(payload: dict[str, Any]) -> None:
    global _hello, _prediction
    kind = payload.get("type")
    with _lock:
        if kind == "hello":
            _hello = payload
        elif kind == "prediction":
            _prediction = payload
        elif kind == "feedback_ack":
            _acks.appendleft(payload)
        snapshot = {
            "status": _status,
            "hello": _hello,
            "prediction": _prediction,
            "acks": list(_acks),
        }
        clients = list(_clients)
    _print_event(payload)
    dead = []
    line = f"data: {json.dumps(snapshot, ensure_ascii=False)}\n\n".encode("utf-8")
    for writer in clients:
        try:
            writer.write(line)
            writer.flush()
        except Exception:
            dead.append(writer)
    if dead:
        with _lock:
            for writer in dead:
                if writer in _clients:
                    _clients.remove(writer)


def _set_status(text: str) -> None:
    global _status
    with _lock:
        _status = text
    print(f"[follow] {text}", flush=True)


def follow_loop(host: str, port: int, reconnect_sec: float) -> None:
    while True:
        _set_status(f"正在连接 tcp://{host}:{port}")
        sock = None
        try:
            sock = socket.create_connection((host, port), timeout=8)
            sock.settimeout(30)
            _set_status(f"已连接 {host}:{port}")
            buffer = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    raise ConnectionError("实验机断开")
                buffer += chunk
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    line = raw.strip()
                    if not line:
                        continue
                    payload = json.loads(line.decode("utf-8"))
                    if isinstance(payload, dict):
                        _apply_event(payload)
        except KeyboardInterrupt:
            raise
        except Exception as error:
            _set_status(f"断开：{error}；{reconnect_sec:g}s 后重连")
            time.sleep(reconnect_sec)
        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass


HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>REVE 在线学习跟随</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0f141c; color:#e8edf5; margin:0; padding:24px; }
    h1 { font-size:22px; margin:0 0 8px; }
    .muted { color:#93a0b5; font-size:14px; }
    .card { background:#171e2b; border:1px solid #2a3550; border-radius:12px; padding:16px; margin-top:16px; }
    .row { display:flex; gap:28px; flex-wrap:wrap; margin-bottom:16px; }
    .big { font-size:36px; font-weight:650; margin:0; }
    .bar { height:8px; background:#243044; border-radius:99px; overflow:hidden; }
    .fill { height:100%; background:#5b8cff; }
    .lab { display:flex; justify-content:space-between; font-size:13px; margin:8px 0 4px; }
  </style>
</head>
<body>
  <h1>REVE 在线学习跟随</h1>
  <p class="muted" id="status">连接中…</p>
  <div class="card">
    <div class="row">
      <div><p class="muted">预测</p><p class="big" id="cls">—</p></div>
      <div><p class="muted">置信度</p><p class="big" id="conf">—</p></div>
      <div><p class="muted">在线步数</p><p class="big" id="step">—</p></div>
      <div><p class="muted">任务</p><p class="big" id="task">—</p></div>
    </div>
    <div id="bars"></div>
    <p class="muted" id="rev"></p>
  </div>
  <script>
    const colors = ['#38d39f','#5b8cff','#c084fc','#e8b84a','#ff6b3d','#22d3ee','#f472b6'];
    function names(s) {
      return (s.prediction && s.prediction.class_names)
        || (s.hello && s.hello.model && s.hello.model.class_names)
        || (s.hello && s.hello.class_names) || [];
    }
    function render(s) {
      document.getElementById('status').textContent = s.status || '';
      const p = s.prediction || {};
      const h = s.hello || {};
      document.getElementById('cls').textContent = p.class_name || '—';
      document.getElementById('conf').textContent = p.confidence == null ? '—' : Math.round(p.confidence * 100) + '%';
      document.getElementById('step').textContent = p.online_update_step ?? '—';
      document.getElementById('task').textContent = p.task || (h.model && h.model.task) || h.task || '—';
      document.getElementById('rev').textContent = '修订 ' + (p.model_revision || (h.online && h.online.model_revision) || '—');
      const cls = names(s);
      const probs = p.probabilities || [];
      document.getElementById('bars').innerHTML = cls.map((name, i) => {
        const v = Math.max(0, Math.min(100, (probs[i] || 0) * 100));
        return '<div class="lab"><span>' + name + '</span><span>' + v.toFixed(1) + '%</span></div>'
          + '<div class="bar"><div class="fill" style="width:' + v + '%;background:' + colors[i % colors.length] + '"></div></div>';
      }).join('');
    }
    const es = new EventSource('/events');
    es.onmessage = (ev) => { try { render(JSON.parse(ev.data)); } catch (e) {} };
  </script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/index.html"):
            data = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            line = f"data: {json.dumps(_snapshot(), ensure_ascii=False)}\n\n".encode("utf-8")
            self.wfile.write(line)
            self.wfile.flush()
            with _lock:
                _clients.append(self.wfile)
            try:
                while True:
                    time.sleep(30)
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except Exception:
                with _lock:
                    if self.wfile in _clients:
                        _clients.remove(self.wfile)
            return
        self.send_error(404)


def main() -> None:
    parser = argparse.ArgumentParser(description="接收实验机 REVE 在线学习 TCP JSONL（单文件，无需仓库）")
    parser.add_argument("--host", required=True, help="实验机局域网 IP，例如 192.168.1.8")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="实验机 TCP 端口，默认 8769")
    parser.add_argument("--http-port", type=int, default=DEFAULT_HTTP_PORT, help="本机网页端口，默认 8770")
    parser.add_argument("--no-http", action="store_true", help="只在终端打印，不启本地网页")
    parser.add_argument("--reconnect", type=float, default=2.0, help="断开后重连间隔秒")
    args = parser.parse_args()

    if not args.no_http:
        server = ThreadingHTTPServer(("127.0.0.1", args.http_port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"[follow] 本机网页 http://127.0.0.1:{args.http_port}", flush=True)

    worker = threading.Thread(
        target=follow_loop,
        args=(args.host, args.port, args.reconnect),
        daemon=True,
    )
    worker.start()
    try:
        while worker.is_alive():
            worker.join(0.5)
    except KeyboardInterrupt:
        print("\n[follow] bye", flush=True)
        sys.exit(130)


if __name__ == "__main__":
    main()
