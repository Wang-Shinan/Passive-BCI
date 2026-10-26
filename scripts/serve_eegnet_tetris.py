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
import hashlib
import time
import uuid
import os
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


def load_model(checkpoint: Path | None = None, *, seed: int = SEED, channels: int = N_CHANNELS,
               output: Path | None = None) -> EEGNet:
    """Load an entire EEGNet checkpoint, or explicitly initialize a new one."""
    if checkpoint is not None:
        raw = checkpoint.read_bytes()
        from io import BytesIO
        payload = torch.load(BytesIO(raw), map_location='cpu', weights_only=True)
        if payload.get('architecture') != 'eegnet':
            raise ValueError('Checkpoint architecture must be eegnet')
        channels = int(payload['n_channels'])
        samples = int(payload['n_samples'])
        rate = float(payload['sample_rate'])
        classes = tuple(payload['class_names'])
        if classes != CLASS_NAMES:
            raise ValueError('EEGNet checkpoint must use left_hand, right_hand, tongue, rest in that order')
        if not 1 <= channels <= 128 or not 32 <= samples <= 20000 or not 1 <= rate <= 10000:
            raise ValueError('Invalid EEGNet input dimensions')
        if payload.get('normalization', 'per-channel-zscore') != 'per-channel-zscore':
            raise ValueError('Unsupported checkpoint preprocessing')
        model = EEGNet(channels, samples, len(classes))
        model.load_state_dict(payload['state_dict'], strict=True)
        revision = 'eegnet-' + hashlib.sha256(raw).hexdigest()[:16]
        initialization = str(payload.get('init', 'checkpoint'))
        saved_path = checkpoint
    else:
        if not 1 <= channels <= 128:
            raise ValueError('channels must be in 1..128')
        torch.manual_seed(seed)
        samples, rate, classes = N_SAMPLES, SAMPLE_RATE, CLASS_NAMES
        model = EEGNet(channels, samples, len(classes))
        payload = dict(architecture='eegnet', init='random', seed=seed, n_channels=channels,
                       n_samples=samples, sample_rate=rate, window_sec=samples/rate,
                       normalization='per-channel-zscore', class_names=list(classes), state_dict=model.state_dict())
        saved_path = output or Path(__file__).resolve().parents[1] / 'recordings/.eegnet' / f'random-{seed}-{uuid.uuid4().hex[:8]}.pt'
        saved_path.parent.mkdir(parents=True, exist_ok=True)
        with saved_path.open('xb') as stream:
            torch.save(payload, stream)
        revision = 'eegnet-' + hashlib.sha256(saved_path.read_bytes()).hexdigest()[:16]
        initialization = 'random'
    if any(not torch.isfinite(tensor).all() for tensor in model.state_dict().values()):
        raise ValueError('Checkpoint contains non-finite weights')
    model.config = dict(channels=channels, samples=samples, sample_rate=rate, class_names=classes,
                        revision=revision, initialization=initialization, checkpoint=str(saved_path))
    model.eval()
    print('[eegnet] ' + json.dumps(model.config), flush=True)
    if initialization == 'random':
        print('[eegnet] Random weights: pipeline/acquisition only, not a trained classifier.', flush=True)
    return model


def fit_window(model: EEGNet, header: dict, payload: bytes) -> torch.Tensor:
    channels, samples = int(header['channels']), int(header['samples'])
    cfg = model.config
    if channels != cfg['channels']:
        raise ValueError(f"Checkpoint requires {cfg['channels']} channels, received {channels}; no silent padding/truncation")
    if samples <= 0 or len(payload) != channels * samples * 4:
        raise ValueError('Invalid EEG window byte length')
    rate = float(header['sample_rate'])
    if rate <= 0 or abs(samples/rate - cfg['samples']/cfg['sample_rate']) > 1/rate:
        raise ValueError('EEG window duration differs from checkpoint')
    if header.get('unit', 'uV') != 'uV' or header.get('layout', 'CT') != 'CT':
        raise ValueError('Expected uV channel-major EEG')
    data = np.frombuffer(payload, dtype='<f4').reshape(channels, samples).copy()
    if not np.isfinite(data).all():
        raise ValueError('EEG contains non-finite samples')
    tensor = torch.from_numpy(data).unsqueeze(0)
    if samples != cfg['samples']:
        tensor = torch.nn.functional.interpolate(tensor, size=cfg['samples'], mode='linear', align_corners=False)
    mean = tensor.mean(dim=-1, keepdim=True)
    std = tensor.std(dim=-1, keepdim=True, unbiased=False).clamp_min(1e-6)
    return ((tensor - mean) / std).unsqueeze(1)


def predict(model: EEGNet, header: dict, payload: bytes) -> dict:
    start = time.perf_counter()
    window = fit_window(model, header, payload)
    prepared = time.perf_counter()
    with torch.no_grad():
        logits = model(window).squeeze(0)
        probs = torch.softmax(logits, dim=0)
    class_id = int(probs.argmax())
    return dict(type='prediction', schema_version=1, request_id=header['request_id'],
                observation_id=f'eegnet-{uuid.uuid4().hex}', window_id=header.get('window_id', 0),
                segment_id=header['segment_id'], class_id=class_id, class_name=CLASS_NAMES[class_id],
                class_names=list(CLASS_NAMES), probabilities=probs.tolist(), logits=logits.tolist(),
                confidence=float(probs[class_id]), model_revision=model.config['revision'],
                online_update_step=0, online_update_applied=False,
                prepare_latency_ms=(prepared-start)*1000, inference_latency_ms=(time.perf_counter()-prepared)*1000,
                task='smr_control', output_semantics='smr_control_4')


def hello_payload(model: EEGNet) -> dict:
    cfg = model.config
    return dict(type='hello', schema_version=1, service='eegnet-tetris',
                model=dict(name='eegnet', type='eegnet', task='smr_control'), class_names=list(CLASS_NAMES),
                online=dict(model_revision=cfg['revision'], strategy='none'),
                input=dict(window_sec=cfg['samples']/cfg['sample_rate'], step_sec=STEP_SEC, slide_sec=STEP_SEC,
                           channels=cfg['channels'], sample_rate=cfg['sample_rate'], unit='uV', layout='CT'),
                initialization=cfg['initialization'], supports_group_training=False)


async def handle(websocket, model: EEGNet) -> None:
    pending = None
    await websocket.send(json.dumps(hello_payload(model)))
    async for message in websocket:
        request_id = None
        try:
            if isinstance(message, str):
                item = json.loads(message)
                if item.get('type') == 'hello':
                    await websocket.send(json.dumps(hello_payload(model)))
                elif item.get('type') == 'window':
                    pending = item
                elif item.get('type') == 'feedback':
                    await websocket.send(json.dumps(dict(type='feedback_ack', schema_version=1,
                        feedback_id=item.get('feedback_id',''), observation_id=item.get('observation_id',''),
                        accepted=False, reason='EEGNet is frozen until training', model_revision=model.config['revision'], online_update_applied=False)))
                continue
            if pending is None:
                raise ValueError('Binary EEG requires a window header')
            header, pending = pending, None
            request_id = header.get('request_id')
            reply = predict(model, header, bytes(message))
        except (ValueError, KeyError, TypeError) as error:
            pending = None
            reply = dict(type='error', schema_version=1, code='invalid_window', message=str(error), request_id=request_id)
        await websocket.send(json.dumps(reply))


async def main(args) -> None:
    from websockets.asyncio.server import serve
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    model = load_model(args.checkpoint, seed=args.seed, channels=args.channels, output=args.output)
    async with serve(lambda ws: handle(ws, model), args.host, args.port, max_size=16*1024*1024, compression=None):
        print(f"[model-service] EEGNet revision={model.config['revision']} ws://{args.host}:{args.port}/v1/model", flush=True)
        print('[model-service] waiting for Passive BCI windows', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=PORT)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--seed', type=int, default=SEED)
    parser.add_argument('--channels', type=int, default=N_CHANNELS)
    parser.add_argument('--output', type=Path)
    asyncio.run(main(parser.parse_args()))
