"""Two independent, frozen binary REVE models on the same EEG window.

The four values are two binary distributions, NOT a four-class softmax.
Both axes are emitted atomically so clients cannot combine different windows.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import math
import time

import numpy as np
import torch

from .protocol import PredictionResult, ProtocolError, feedback_ack_message, hello_message, new_observation_id
from .reve import ReveModelBackend, ReveTaskSpec
from .reve_lora import apply_merged_state_dict, merge_peft_lora_state_dict

DUAL_TASK = 'smr_dual_axis'
DUAL_SEMANTICS = 'smr_independent_binary_axes'
AXIS_CLASSES = {'left_right': ('left_hand', 'right_hand'), 'up_down': ('tongue', 'rest')}
CLASSES = AXIS_CLASSES['left_right'] + AXIS_CLASSES['up_down']


def read_dual_axis_manifest(path: Path, *, verify_hash: bool = False) -> dict:
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('schema') != 'smr.dual-axis.v1' or value.get('task') != DUAL_TASK:
        raise ValueError('Invalid dual-axis model manifest')
    if set(value.get('axes', {})) != set(AXIS_CLASSES):
        raise ValueError('Both left_right and up_down checkpoints are required')
    for axis in AXIS_CLASSES:
        item = value['axes'][axis]
        checkpoint = Path(item['checkpoint'])
        if not checkpoint.is_absolute():
            checkpoint = path.parent / checkpoint
        if not checkpoint.is_file():
            raise ValueError(f'Missing {axis} checkpoint: {checkpoint}')
        digest = item.get('sha256', '')
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError(f'Invalid {axis} SHA256')
        if verify_hash:
            with checkpoint.open('rb') as stream:
                actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            if actual != digest:
                raise ValueError(f'{axis} checkpoint SHA256 mismatch')
        item['checkpoint'] = str(checkpoint.resolve())
    return value


class BinaryAxisBackend(ReveModelBackend):
    def __post_init__(self) -> None:
        if self.task not in AXIS_CLASSES:
            raise ValueError('Binary axis must be left_right or up_down')
        self.class_names = AXIS_CLASSES[self.task]
        self._replay = [[], []]
        self.window_sec = 4
        self.step_sec = .5 if self.step_sec is None else float(self.step_sec)
        if not math.isfinite(self.step_sec) or not 0 < self.step_sec <= 4:
            raise ValueError('Dual-axis hop must be in (0, 4] seconds')
        if self.strategy != 'none' or self.state_file is not None:
            raise ValueError('Binary checkpoints are frozen and do not accept a separate head')

    @property
    def task_spec(self) -> ReveTaskSpec:
        return ReveTaskSpec(self.task, self.class_names, 'known_axis_binary', self.task, float(self.step_sec))

    def _apply_lora_checkpoint(self) -> None:
        if self.lora_checkpoint is None:
            raise ValueError('Binary axis requires its full checkpoint')
        payload = torch.load(self.lora_checkpoint, map_location='cpu', weights_only=True)
        config = payload.get('config', {})
        if tuple(payload.get('classes', [])) != self.class_names or config.get('task') != self.task:
            raise ValueError('Binary checkpoint labels/axis mismatch')
        if config.get('input_shape') != [31, 800] or config.get('sample_rate') != 200 or config.get('window_seconds') != 4:
            raise ValueError('Binary checkpoint must specify 31 channels, 200 Hz, 4 seconds')
        names = tuple(payload['channels'])
        if len(names) != 31 or len(set(names)) != 31:
            raise ValueError('Binary checkpoint requires 31 distinct electrodes')
        state = payload['model']
        merged = merge_peft_lora_state_dict(state, rank=int(config['lora_rank']), alpha=float(config['lora_alpha']))
        stats = apply_merged_state_dict(self._model, merged)
        if stats['missing'] or stats['unexpected'] or stats['skipped_unknown']:
            raise ValueError(f'Incomplete binary backbone import: {stats}')
        self._head.load_state_dict({'weight': state['head.fc.weight'], 'bias': state['head.fc.bias']}, strict=True)
        positions = self._pos_bank(list(names)).detach().cpu()
        if not torch.allclose(positions, state['encoder.pos'].cpu(), atol=1e-7, rtol=0):
            raise ValueError('Binary checkpoint electrode positions differ from the serving position bank')
        self.feature_normalization = 'none'
        self.input_clip = 15
        self.preprocessing_profile = 's04-mne-4s-v1'
        self.input_channel_names = names
        self._head_source = 'lora-checkpoint'
        print(f'[reve] binary-axis={self.task} classes={self.class_names} loaded={stats["loaded"]}', flush=True)


def combine_axis_predictions(horizontal: PredictionResult, vertical: PredictionResult, revision: str) -> PredictionResult:
    if (horizontal.request_id, horizontal.window_id, horizontal.segment_id) != (vertical.request_id, vertical.window_id, vertical.segment_id):
        raise ProtocolError('Binary axes must come from the same EEG window', code='internal_error')
    for result, expected in [(horizontal, AXIS_CLASSES['left_right']), (vertical, AXIS_CLASSES['up_down'])]:
        if result.class_names != expected or len(result.probabilities) != 2:
            raise ProtocolError('Unexpected binary class order', code='internal_error')
        if not all(math.isfinite(p) and 0 <= p <= 1 for p in result.probabilities) or abs(sum(result.probabilities) - 1) > 1e-6:
            raise ProtocolError('Invalid binary probabilities', code='internal_error')
        if result.logits is None or len(result.logits) != 2 or not all(math.isfinite(z) for z in result.logits):
            raise ProtocolError('Missing binary logits', code='internal_error')
    probabilities = horizontal.probabilities + vertical.probabilities
    winner = int(np.argmax(probabilities))  # protocol summary only; never a four-way decision
    return PredictionResult(
        request_id=horizontal.request_id, observation_id=new_observation_id(),
        window_id=horizontal.window_id, segment_id=horizontal.segment_id,
        class_id=winner, class_name=CLASSES[winner], class_names=CLASSES,
        probabilities=probabilities, logits=horizontal.logits + vertical.logits,
        confidence=float(probabilities[winner]), model_revision=revision, task=DUAL_TASK,
        output_semantics=DUAL_SEMANTICS,
        prepare_latency_ms=horizontal.prepare_latency_ms + vertical.prepare_latency_ms,
        inference_latency_ms=horizontal.inference_latency_ms + vertical.inference_latency_ms,
    )


class DualAxisReveBackend:
    task = DUAL_TASK
    class_names = CLASSES
    strategy = 'none'
    window_sec = 4
    target_hz = 200

    def __init__(self, model_dir: Path, positions_dir: Path, state_file: Path, *, device: str = 'auto', step_sec: float = .5):
        self.model_dir, self.positions_dir, self.state_file = model_dir, positions_dir, state_file
        self.device, self.step_sec = device, step_sec
        self.axes: dict[str, BinaryAxisBackend] = {}
        self.model_revision = ''

    @property
    def torch_device_name(self) -> str:
        return self.axes['left_right'].torch_device_name

    def load(self) -> None:
        manifest = read_dual_axis_manifest(self.state_file, verify_hash=True)
        revisions = []
        for axis in AXIS_CLASSES:
            item = manifest['axes'][axis]
            backend = BinaryAxisBackend(self.model_dir, self.positions_dir, device=self.device,
                task=axis, strategy='none', step_sec=self.step_sec, lora_checkpoint=Path(item['checkpoint']))
            backend.load()
            self.axes[axis] = backend
            revisions.append(f'{axis}:{item["sha256"][:12]}')
        if self.axes['left_right'].input_channel_names != self.axes['up_down'].input_channel_names:
            raise ValueError('Binary axes must use the same input electrodes in the same order')
        self.model_revision = '|'.join(revisions)
        print(f'[reve] state-file loaded dual-axis {self.state_file.name} revision={self.model_revision}', flush=True)

    def hello_payload(self) -> dict:
        payload = hello_message(service='ncc-reve-dual-axis', model_name='S04 REVE · LR + UD binary', model_type='reve',
            task=self.task, class_names=self.class_names, model_revision=self.model_revision, strategy='none', window_sec=4, step_sec=self.step_sec)
        payload['input']['slide_sec'] = .1
        payload['supports_group_training'] = False
        payload['warning'] = '左右／上下為獨立二分類，每軸機率各自合計 100%；雙軸同時控制屬探索性使用，並非四分類。'
        payload['output_semantics'] = DUAL_SEMANTICS
        return payload

    def predict(self, window) -> PredictionResult:
        started = time.perf_counter()
        results = [self.axes[axis].predict(window) for axis in AXIS_CLASSES]
        result = combine_axis_predictions(*results, self.model_revision)
        if time.perf_counter() - started > 10:
            raise ProtocolError('Dual-axis inference exceeded 10 seconds', code='inference_timeout', request_id=window.request_id)
        return result

    def ack_feedback(self, feedback) -> dict:
        return feedback_ack_message(feedback, accepted=False, reason='Independent binary models are frozen', model_revision=self.model_revision)
