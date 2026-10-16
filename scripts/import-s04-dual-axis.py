"""Register the two downloaded S04 binary checkpoints without changing the active model."""
import argparse
import hashlib
import json
import os
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-dir', type=Path, default=ROOT.parent / 'NCC-OI-BCI/checkpoints/imports/s04_reve_20261015/binary_4s')
parser.add_argument('--output', type=Path, default=ROOT / 'recordings/.reve-dual-axis/s04_binary_4s.json')
args = parser.parse_args()
checks = json.loads((args.source_dir / 'SHA256.json').read_text(encoding='utf-8'))
manifest = {'schema': 'smr.dual-axis.v1', 'task': 'smr_dual_axis', 'subject_id': 'S04', 'window_sec': 4, 'axes': {}}
for axis, classes in [('left_right', ['left_hand', 'right_hand']), ('up_down', ['tongue', 'rest'])]:
    relative = f'{axis}/selected/best_lora_full.pt'
    source = args.source_dir / relative
    with source.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if checks[relative] != digest:
        raise ValueError(f'{axis}: supplied SHA256 mismatch')
    payload = torch.load(source, map_location='cpu', weights_only=True)
    if payload['classes'] != classes or payload['config']['input_shape'] != [31, 800]:
        raise ValueError(f'{axis}: incompatible labels/input dimensions')
    manifest['axes'][axis] = {'checkpoint': os.path.relpath(source.resolve(), args.output.parent.resolve()),
        'sha256': digest, 'classes': classes,
        'source_uri': f'cos:omni-eeg-1442740494/omni-eeg-01/wsn/Passive_BCI/models/s04_reve_20261015/binary_4s/{relative}'}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'manifest': str(args.output), 'axes': {axis: item['sha256'] for axis, item in manifest['axes'].items()}}))
