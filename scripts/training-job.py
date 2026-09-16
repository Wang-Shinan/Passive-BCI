"""Export labeled SMR EEG and fit frozen-REVE linear probes from the exported H5."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace


def grouped_split(labels, groups, seed):
    import numpy as np
    unique = sorted(set(groups))
    if len(unique) < 3:
        raise ValueError('至少需要 3 个独立分组，才能分开训练/验证/测试集')
    rng = np.random.default_rng(seed)
    classes = set(labels.tolist())
    val_size = max(1, round(len(unique) * .2))
    test_size = max(1, round(len(unique) * .2))
    for _ in range(1000):
        order = rng.permutation(unique)
        subsets = [set(order[val_size + test_size:]), set(order[:val_size]), set(order[val_size:val_size + test_size])]
        indices = [np.array([i for i, group in enumerate(groups) if group in subset], dtype=int) for subset in subsets]
        if all(set(labels[idx].tolist()) == classes for idx in indices):
            return indices
    raise ValueError('无法让三个独立分组都包含所有类别；请补充会话/试次，或更换分组方式')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ncc', required=True)
    parser.add_argument('--job', required=True)
    args = parser.parse_args()
    sys.path[:0] = [str(Path(args.ncc) / 'src'), str(Path(args.ncc) / 'scripts')]
    job_file = Path(args.job)
    job = json.loads(job_file.read_text(encoding='utf-8'))
    config = job['config']
    out = job_file.parent
    import numpy as np
    import h5py
    from bci_dayloop.data.hdf5_dataset import EEGHDF5
    from bci_dayloop.serving.smr_sessions import extract_all_labeled_windows, windows_to_hdf5

    if job['kind'] == 'export':
        print('[export] extracting labeled 2s non-overlapping windows', flush=True)
        windows = extract_all_labeled_windows([Path(p) for p in config['sessions']], window_sec=2, hop_sec=2, label_source=config['labelSource'])
        kept = [w for w in windows if not w.padded]
        target = out / 'dataset.h5'
        windows_to_hdf5(kept, target, subject_id=config['subjectId'])
        # Older recordings may lack trial IDs. Keep those sessions together rather
        # than treating the extractor's per-window fallback IDs as real trials.
        session_groups = set()
        for recording in config['sessions']:
            events = [json.loads(line) for line in (Path(recording) / 'events.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
            kinds = ['trial'] if config['labelSource'] == 'trial' else ['smr_window', 'foundation_label', 'trial']
            chosen = next(([e for e in events if e.get('type') == kind] for kind in kinds if any(e.get('type') == kind for e in events)), [])
            if any(all((event.get('data') or {}).get(key) is None for key in ('trialIndex', 'index')) for event in chosen):
                session_groups.add(Path(recording).name)
        with h5py.File(target, 'a') as handle:
            handle.create_dataset('source_trial_ids', data=np.array([-1 if w.session_id in session_groups else w.trial_index for w in kept], dtype=np.int64))
        dataset = EEGHDF5(target)
        loaded = dataset.load()
        if not np.isfinite(loaded['data']).all():
            raise ValueError('EEG 包含非有限数值，请先检查采集数据')
        report = {'kind': 'export', 'shape': list(loaded['data'].shape), 'sampleRate': dataset.metadata.sample_rate,
                  'classNames': dataset.metadata.class_names, 'counts': np.bincount(loaded['labels'], minlength=4).tolist(),
                  'sessions': dataset.sessions(), 'windowSec': 2, 'hopSec': 2, 'droppedPadded': len(windows) - len(kept),
                  'missingTrialIdSessions': sorted(session_groups)}
    else:
        import torch
        from bci_dayloop.serving.reve import ReveModelBackend, default_checkpoint_root
        from fit_smr_control_head import encode_windows, train_linear_head
        dataset = EEGHDF5(config['dataset'])
        loaded = dataset.load()
        meta = dataset.metadata
        if meta.class_names != ['left_hand', 'right_hand', 'both_hand', 'rest'] or meta.unit != 'uV':
            raise ValueError('训练只接受 SMR 四类、单位 uV 的 H5')
        if set(loaded['labels'].tolist()) != {0, 1, 2, 3}:
            raise ValueError('数据必须包含左手、右手、双手和休息四类')
        if config['splitBy'] == 'session':
            groups = loaded['session_ids'].tolist()
        else:
            with h5py.File(config['dataset'], 'r') as handle:
                source_trials = handle['source_trial_ids'][:]
            groups = [f'{s}:{t}' for s, t in zip(loaded['session_ids'], source_trials)]
        indices = grouped_split(loaded['labels'], groups, config['seed'])
        print('[fit] grouped train/validation/test sizes:', [len(i) for i in indices], flush=True)
        torch.manual_seed(config['seed'])
        root = default_checkpoint_root()
        backend = ReveModelBackend(model_dir=root / ('reve-' + config['size']), positions_dir=root / 'reve-positions',
                                   device=config['device'], strategy='none', task='smr_control', state_file=None,
                                   cache_size=max(128, len(loaded['labels']) + 8),
                                   lora_checkpoint=Path(config['loraCheckpoint']) if config['loraCheckpoint'] else None)
        backend.load()
        windows = [SimpleNamespace(data=data, class_id=int(label), sample_rate=meta.sample_rate,
                                   channel_names=tuple(meta.channel_names), session_id=str(session))
                   for data, label, session in zip(loaded['data'], loaded['labels'], loaded['session_ids'])]
        features, labels = encode_windows(backend, windows)
        train, val, test = [torch.tensor(idx, device=labels.device) for idx in indices]
        train_linear_head(backend._head, features[train], labels[train], epochs=config['epochs'], lr=config['lr'],
                          val_features=features[val], val_labels=labels[val], reset=True)
        metrics = {}
        with torch.no_grad():
            for name, idx in zip(('train', 'validation', 'test'), (train, val, test)):
                prediction = backend._head(features[idx]).argmax(1)
                confusion = torch.bincount(labels[idx] * 4 + prediction, minlength=16).reshape(4, 4).cpu()
                recalls = confusion.diag().float() / confusion.sum(1).clamp_min(1)
                metrics[name] = {'count': len(idx), 'accuracy': float((prediction == labels[idx]).float().mean()),
                                 'balancedAccuracy': float(recalls.mean()), 'confusion': confusion.tolist()}
        head = out / 'head.pt'
        # File handles avoid older PyTorch's Windows non-ASCII path limitation.
        with head.open('wb') as handle:
            torch.save({'head': {key: value.detach().cpu() for key, value in backend._head.state_dict().items()},
                        'task': 'smr_control', 'encoder_id': backend.encoder_id, 'step': config['epochs'],
                        'trained_at': datetime.now(timezone.utc).isoformat(),
                        'model_revision': 'web-lp-' + job['id']}, handle)
        published = Path(config['headOutput'])
        published.parent.mkdir(parents=True, exist_ok=True)
        if published.exists():
            raise FileExistsError('产物已存在，拒绝覆盖：' + str(published))
        shutil.copy2(head, published)
        report = {'kind': 'fit', 'encoderId': backend.encoder_id, 'headId': published.name, 'classNames': meta.class_names,
                  'metrics': metrics, 'splitBy': config['splitBy'], 'splitIndices': [idx.tolist() for idx in indices],
                  'dataset': config['dataset'], 'seed': config['seed'], 'epochs': config['epochs'], 'lr': config['lr']}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True), flush=True)
    print('[done] artifacts saved', flush=True)


if __name__ == '__main__':
    main()
