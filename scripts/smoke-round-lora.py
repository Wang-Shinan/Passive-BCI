"""Exercise real CUDA round-end LoRA, saved package reload, and a second residual adapter.

Uses synthetic EEG only; all artifacts stay in the specified output directory.
Does not start/stop model services or publish participant models.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ncc', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.path[:0] = [str(args.ncc / 'src'), str(args.ncc / 'scripts')]
    import h5py
    import numpy as np
    import torch
    from bci_dayloop.data.hdf5_dataset import HDF5Metadata, write_hdf5
    from bci_dayloop.serving.profiles import BCIGO32_PROFILE
    from bci_dayloop.serving.reve import ReveModelBackend, default_checkpoint_root
    from bci_dayloop.serving import reve
    from fit_smr_control_head import encode_windows
    from grouped_probe import classification_metrics
    import round_lora

    if not torch.cuda.is_available():
        raise RuntimeError('此实测要求 CUDA；未静默回退 CPU')
    torch.set_num_threads(4)
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('training_job', Path(__file__).with_name('training-job.py'))
    job_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(job_module)
    names = list(BCIGO32_PROFILE.channel_names)
    labels = np.tile(np.arange(4), 5)
    data = np.random.default_rng(41).normal(0, 10, (20, len(names), 500)).astype(np.float32)
    dataset = args.output / 'dataset.h5'
    write_hdf5(dataset, data, labels, np.ones(20, dtype=np.int64), ['synthetic'] * 20, np.arange(20),
               HDF5Metadata(250, names, ['left_hand', 'right_hand', 'tongue', 'rest'], 'uV', 'smr_control'))
    with h5py.File(dataset, 'a') as handle:
        handle.create_dataset('source_trial_ids', data=np.arange(20))
    recording = args.output / 'synthetic'; recording.mkdir()
    (recording / 'eeg.json').write_text(json.dumps({'format': 'float32-le-interleaved', 'unit': 'uV'}))
    (recording / 'eeg.bin').write_bytes(data.tobytes())
    (recording / 'events.jsonl').write_text('{}\n')
    (recording / 'session.json').write_text('{}')
    history = {'rounds': [dict(id='synthetic', seed=41, sessions=[str(recording)],
                splitLedger=str(args.output / 'split.json'), recordingManifest=str(args.output / 'recordings.json'))], 'skipped': []}
    baseline_state, adapter, revision = None, None, 'reve-base'
    summary = {'synthetic': True, 'participantAccuracyValidated': False, 'gpu': torch.cuda.get_device_name(), 'runs': []}
    for iteration in range(2):
        out = args.output / f'job{iteration}'; out.mkdir()
        config = dict(dataset=str(dataset), splitBy='trial', seed=41, size='base', device='cuda',
                      roundId='synthetic', history=history, loraCheckpoint=adapter, baselineStateFile=baseline_state,
                      baselineRevision=revision, baselineOutput=str(out / 'baseline.pt'),
                      adapterOutput=str(out / f'synthetic_adapter_{iteration}' / 'best.pt'), headOutput=str(out / 'published.pt'),
                      epochs=1, lr=.0001, rank=4, alpha=8, batchSize=1, accumulationSteps=8,
                      minimumGain=.02, maximumRecallDrop=0.)
        job_file = out / 'job.json'
        job_file.write_text(json.dumps(dict(id=f'synthetic-{iteration}', kind='lora', config=config)))
        visited, expected_logits = [], []
        prepare, train = reve.prepare_reve_window, round_lora.train_round_lora
        def track_prepare(raw, *args, **kwargs):
            visited.append(float(raw[0, 0]))
            return prepare(raw, *args, **kwargs)
        def track_training(backend, windows, train_indices, val_indices, options):
            result = train(backend, windows, train_indices, val_indices, options)
            encoded, _ = encode_windows(backend, [windows[i] for i in val_indices])
            with torch.no_grad():
                expected_logits.append(backend._head(encoded).cpu())
            return result
        with patch.object(sys, 'argv', ['training-job.py', '--ncc', str(args.ncc), '--job', str(job_file)]), \
                patch.object(reve, 'prepare_reve_window', track_prepare), \
                patch.object(round_lora, 'train_round_lora', track_training):
            job_module.main()
        report = json.loads((out / 'report.json').read_text())
        assert 'test' not in report['metrics'] and report['testReserved'] == 4
        assert [len(idx) for idx in report['splitIndices']] == [12, 4, 4]
        assert not set(visited).intersection(float(data[i, 0, 0]) for i in report['splitIndices'][2])
        root = default_checkpoint_root()
        backend = ReveModelBackend(root / 'reve-base', root / 'reve-positions', device='cuda', task='smr_control',
                                   strategy='none', lora_checkpoint=Path(config['adapterOutput']), state_file=Path(config['headOutput']))
        backend.load()
        assert backend.model_revision == report['modelRevision']
        windows = [SimpleNamespace(data=data[i], class_id=int(labels[i]), sample_rate=250,
                                   channel_names=tuple(names), session_id='synthetic') for i in report['splitIndices'][1]]
        features, targets = encode_windows(backend, windows)
        reloaded = classification_metrics(backend._head, features, targets)
        assert reloaded['confusion'] == report['metrics']['validation']['confusion'], (reloaded, report['metrics'])
        with torch.no_grad():
            assert torch.allclose(backend._head(features).cpu(), expected_logits[0], atol=1e-5, rtol=1e-4)
        payload = torch.load(config['adapterOutput'], map_location='cpu', weights_only=True)
        updates = [value for key, value in payload['model'].items() if '.lora_B.' in key]
        assert updates and any(torch.count_nonzero(value) > 0 for value in updates)
        summary['runs'].append({'lora': report['lora'], 'reloadValidationMatches': True, 'reloadLogitsMatch': True,
                                'testNeverPrepared': True, 'adapterUpdated': True,
                                'testReserved': report['testReserved'], 'revision': backend.model_revision})
        baseline_state, adapter, revision = config['headOutput'], config['adapterOutput'], report['modelRevision']
        del backend, features, targets, payload, updates
        torch.cuda.empty_cache()
    (args.output / 'smoke-report.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
