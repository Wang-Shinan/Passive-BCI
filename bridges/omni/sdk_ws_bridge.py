"""Shared ESP32 BLE acquisition for the browser and local model service."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

root = Path(os.environ.get("NCC_OI_BCI_ROOT", Path(__file__).resolve().parents[3] / "NCC-OI-BCI"))
sys.path.insert(0, str(root / "src"))


async def serve():
    from websockets.asyncio.server import serve as ws_serve
    from bci_dayloop.serving.omni_relay import OmniRelay
    relay = OmniRelay()
    async with ws_serve(relay.handle, "127.0.0.1", 8772, compression=None, max_size=65536):
        print("[omni-sdk-bridge] ready ws://127.0.0.1:8772/v1/stream", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--discover", action="store_true")
    args = parser.parse_args()
    if args.discover:
        from omnibci import Board
        devices = Board.discover(transport="ble", timeout=10)
        print(json.dumps({"ok": True, "devices": [{"name": d.name, "endpoint": d.endpoint, "rssi": d.rssi_dbm} for d in devices]}, ensure_ascii=True))
    else:
        asyncio.run(serve())
