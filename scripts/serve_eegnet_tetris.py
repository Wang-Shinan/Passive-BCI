"""Randomly initialized EEGNet for grouped SMR acquisition.

Classes are left_hand, right_hand, tongue, and rest. The convolutional stack is
the encoder. The final linear layer is the classifier kept separate so a later
run can train that layer first, then fine-tune the stack. This process does not
apply LoRA or online updates.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from pathlib import Path

import numpy as np
import torch
from torch import nn

CLASS_NAMES = ("left_hand", "right_hand", "tongue", "rest")
REVISION = "eegnet-smr-random-20261022"
WINDOW_SEC = 2.0
STEP_SEC = 0.1
SAMPLE_RATE = 250
N_CHANNELS = 32
N_SAMPLES = int(WINDOW_SEC * SAMPLE_RATE)
SEED = 20261022
PORT = 8773


class EEGNet(nn.Module):
    def __init__(self, n_channels: int, n_samples: int, n_classes: int) -> None:
        super().__init__()
        f1, depth, f2, dropout = 8, 2, 16, 0.25
        kernel = 64
        self.encoder = nn.Sequential(
            nn.Conv2d(1, f1, (1, kernel), padding=(0, kernel // 2), bias=False),
            nn.BatchNorm2d(f1),
            nn.Conv2d(f1, f1 * depth, (n_channels, 1), groups=f1, bias=False),
            nn.BatchNorm2d(f1 * depth),
            nn.ELU(),
            nn.AvgPool2d((1, 4)),
            nn.Dropout(dropout),
            nn.Conv2d(f1 * depth, f1 * depth, (1, 16), padding=(0, 8), groups=f1 * depth, bias=False),
            nn.Conv2d(f1 * depth, f2, (1, 1), bias=False),
            nn.BatchNorm2d(f2),
            nn.ELU(),
            nn.AvgPool2d((1, 8)),
            nn.Dropout(dropout),
        )
        with torch.no_grad():
            features = self.encoder(torch.zeros(1, 1, n_channels, n_samples))
        self.classifier = nn.Linear(int(features.numel()), n_classes)

    def forward(self, batch: torch.Tensor) -> torch.Tensor:
        encoded = self.encoder(batch)
        return self.classifier(torch.flatten(encoded, 1))


def checkpoint_path() -> Path:
    path = Path(__file__).resolve().parents[1] / "recordings" / ".eegnet" / "smr-random.pt"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def load_model() -> EEGNet:
    torch.manual_seed(SEED)
    model = EEGNet(N_CHANNELS, N_SAMPLES, len(CLASS_NAMES))
    path = checkpoint_path()
    if path.is_file():
        payload = torch.load(path, map_location="cpu", weights_only=False)
        model.load_state_dict(payload["state_dict"])
        print(f"[eegnet] loaded random init {path}", flush=True)
    else:
        torch.save(
            {
                "architecture": "eegnet",
                "init": "random",
                "seed": SEED,
                "revision": REVISION,
                "n_channels": N_CHANNELS,
                "n_samples": N_SAMPLES,
                "sample_rate": SAMPLE_RATE,
                "window_sec": WINDOW_SEC,
                "class_names": list(CLASS_NAMES),
                "next_training": "linear-probe-then-finetune",
                "state_dict": model.state_dict(),
            },
            path,
        )
        print(f"[eegnet] saved random init {path}", flush=True)
    model.eval()
    return model


def fit_window(payload: bytes, channels: int, samples: int) -> torch.Tensor:
    expected = channels * samples * 4
    if len(payload) != expected:
        raise ValueError(f"window bytes {len(payload)} != {expected}")
    data = np.frombuffer(payload, dtype="<f4").reshape(channels, samples).astype(np.float32)
    if channels != N_CHANNELS:
        fitted = np.zeros((N_CHANNELS, samples), dtype=np.float32)
        used = min(channels, N_CHANNELS)
        fitted[:used] = data[:used]
        data = fitted
    if samples != N_SAMPLES:
        source = torch.from_numpy(data).unsqueeze(0).unsqueeze(0)
        data = torch.nn.functional.interpolate(source, size=(N_CHANNELS, N_SAMPLES), mode="bilinear", align_corners=False)
        data = data.squeeze(0).squeeze(0).numpy()
    mean = data.mean(axis=1, keepdims=True)
    std = data.std(axis=1, keepdims=True)
    std[std < 1e-6] = 1.0
    data = (data - mean) / std
    return torch.from_numpy(np.ascontiguousarray(data)).unsqueeze(0).unsqueeze(0)


def predict(model: EEGNet, header: dict, payload: bytes) -> dict:
    started = time.perf_counter()
    window = fit_window(payload, int(header["channels"]), int(header["samples"]))
    prepared = time.perf_counter()
    with torch.no_grad():
        logits = model(window).squeeze(0)
        probabilities = torch.softmax(logits, dim=0)
    finished = time.perf_counter()
    class_id = int(torch.argmax(probabilities).item())
    probs = [float(item) for item in probabilities.tolist()]
    return {
        "type": "prediction",
        "schema_version": 1,
        "request_id": header["request_id"],
        "observation_id": f"eegnet-{uuid.uuid4().hex}",
        "window_id": header.get("window_id", 0),
        "segment_id": header["segment_id"],
        "class_id": class_id,
        "class_name": CLASS_NAMES[class_id],
        "class_names": list(CLASS_NAMES),
        "probabilities": probs,
        "logits": [float(item) for item in logits.tolist()],
        "confidence": probs[class_id],
        "model_revision": REVISION,
        "online_update_step": 0,
        "online_update_applied": False,
        "prepare_latency_ms": (prepared - started) * 1000,
        "inference_latency_ms": (finished - prepared) * 1000,
        "task": "smr_control",
        "output_semantics": "smr_control_4",
    }


def hello_payload() -> dict:
    return {
        "type": "hello",
        "schema_version": 1,
        "service": "eegnet-tetris",
        "model": {"name": "eegnet", "type": "eegnet", "task": "smr_control"},
        "class_names": list(CLASS_NAMES),
        "online": {"model_revision": REVISION, "strategy": "none"},
        "input": {"window_sec": WINDOW_SEC, "step_sec": STEP_SEC, "slide_sec": STEP_SEC},
        "supports_group_training": False,
    }


async def handle(websocket, model: EEGNet) -> None:
    pending: dict | None = None
    await websocket.send(json.dumps(hello_payload()))
    async for message in websocket:
        if isinstance(message, str):
            payload = json.loads(message)
            kind = payload.get("type")
            if kind == "hello":
                await websocket.send(json.dumps(hello_payload()))
            elif kind == "window":
                pending = payload
            elif kind == "feedback":
                await websocket.send(json.dumps({
                    "type": "feedback_ack",
                    "schema_version": 1,
                    "feedback_id": payload.get("feedback_id", ""),
                    "observation_id": payload.get("observation_id", ""),
                    "accepted": False,
                    "reason": "EEGNet is frozen until linear probing",
                    "model_revision": REVISION,
                    "online_update_applied": False,
                }))
            continue
        if pending is None:
            continue
        header = pending
        pending = None
        try:
            reply = predict(model, header, bytes(message))
        except (ValueError, KeyError, TypeError) as error:
            reply = {
                "type": "error",
                "schema_version": 1,
                "code": "invalid_window",
                "message": str(error),
                "request_id": header.get("request_id"),
            }
        await websocket.send(json.dumps(reply))


async def main(host: str, port: int) -> None:
    from websockets.asyncio.server import serve

    model = load_model()
    async with serve(lambda ws: handle(ws, model), host, port, max_size=16 * 1024 * 1024, compression=None):
        print(f"[eegnet] ws://{host}:{port}/v1/model revision={REVISION} window={WINDOW_SEC:g}s", flush=True)
        print("[eegnet] waiting for Passive BCI windows", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    asyncio.run(main(args.host, args.port))
