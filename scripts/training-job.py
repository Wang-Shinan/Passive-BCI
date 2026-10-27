"""Export labeled SMR EEG and train REVE or EEGNet with fixed trial holdouts."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace
from grouped_probe import InsufficientTrials, fixed_split, history_split, classification_metrics, balanced_probe, promotion_decision, seal_recordings


def save_report(out, report):
    temporary = out / 'report.tmp'
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(out / 'report.json')


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


def fit_eegnet(out, job, loaded, meta, indices, snapshot, history_counts):
    from copy import deepcopy
    import hashlib
    import numpy as np
    import torch
    from serve_eegnet_tetris import fit_window, load_model
    config = job['config']
    torch.set_num_threads(4)
    device = config['device']
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    baseline = load_model(Path(config['baselineCheckpoint']))
    if baseline.config['revision'] != config['baselineRevision']:
        raise ValueError('离线 EEGNet 权重与采集模型版本不一致')
    payload = torch.load(config['baselineCheckpoint'], map_location='cpu', weights_only=True)
    if payload.get('channel_names') and payload['channel_names'] != meta.channel_names:
        raise ValueError('EEGNet 通道顺序与录制数据不一致')
    # Reserved tests are neither preprocessed nor passed through the encoder.
    usable = np.concatenate(indices[:2])
    inputs = torch.cat([fit_window(baseline, dict(channels=loaded['data'].shape[1],
        samples=loaded['data'].shape[2], sample_rate=meta.sample_rate),
        loaded['data'][i].astype('<f4').tobytes()) for i in usable]).to(device)
    labels = torch.tensor(loaded['labels'][usable], dtype=torch.long, device=device)
    train = torch.arange(len(indices[0]), device=device)
    val = torch.arange(len(train), len(usable), device=device)
    baseline.to(device).eval()
    before = classification_metrics(baseline, inputs[val], labels[val])
    candidate = deepcopy(baseline)
    torch.manual_seed(config['seed'])
    history = []
    if job['kind'] == 'fit':
        with torch.no_grad():
            features = candidate.encoder(inputs).flatten(1)
        balanced_probe(candidate.classifier, features[train], labels[train], features[val], labels[val],
                       config['epochs'], config['lr'], config['seed'])
        assert all(torch.equal(a, b) for a, b in zip(candidate.encoder.state_dict().values(), baseline.encoder.state_dict().values()))
    else:
        optimizer = torch.optim.AdamW(candidate.parameters(), lr=config['lr'], weight_decay=1e-4)
        classes = [(labels[train] == label).nonzero().flatten() for label in range(4)]
        per_class = max(len(idx) for idx in classes)
        best_score, best_state, best_epoch = -1., None, 0
        for epoch in range(1, config['epochs'] + 1):
            candidate.train()
            selected = torch.cat([idx[torch.randint(len(idx), (per_class,), device=device)] for idx in classes])
            selected = selected[torch.randperm(len(selected), device=device)]
            for batch in selected.split(16):
                optimizer.zero_grad(set_to_none=True)
                loss = torch.nn.functional.cross_entropy(candidate(inputs[batch]), labels[batch], label_smoothing=.05)
                if not torch.isfinite(loss):
                    raise ValueError('EEGNet 训练损失非有限值')
                loss.backward()
                torch.nn.utils.clip_grad_norm_(candidate.parameters(), 1., error_if_nonfinite=True)
                optimizer.step()
            candidate.eval()
            accuracy = classification_metrics(candidate, inputs[val], labels[val])['balancedAccuracy']
            history.append(dict(epoch=epoch, balancedAccuracy=accuracy))
            if accuracy > best_score:
                best_score, best_state, best_epoch = accuracy, deepcopy(candidate.state_dict()), epoch
            if epoch - best_epoch >= 20:
                break
        candidate.load_state_dict(best_state)
    candidate.eval()
    metrics = {name: classification_metrics(candidate, inputs[idx], labels[idx]) for name, idx in (('train', train), ('validation', val))}
    decision = promotion_decision(before, metrics['validation'], config['minimumGain'], config['maximumRecallDrop'])
    payload.update(init='lp' if job['kind'] == 'fit' else 'finetune', normalization_version='dc-centered-v2',
                   channel_names=meta.channel_names, trained_at=datetime.now(timezone.utc).isoformat(),
                   state_dict={key: value.detach().cpu() for key, value in candidate.state_dict().items()})
    head = out / 'head.pt'
    with head.open('xb') as handle:
        torch.save(payload, handle)
    published = Path(config['headOutput'])
    published.parent.mkdir(parents=True, exist_ok=True)
    with head.open('rb') as source, published.open('xb') as target:
        shutil.copyfileobj(source, target)
    restored = load_model(published).to(device)
    with torch.no_grad():
        torch.testing.assert_close(restored(inputs[val]), candidate(inputs[val]), rtol=0, atol=0)
    assert 'eegnet-' + hashlib.sha256(Path(config['baselineCheckpoint']).read_bytes()).hexdigest()[:16] == config['baselineRevision']
    return dict(kind=job['kind'], backend='eegnet', method=payload['init'], headId='', baselineHeadId='',
                weightId=config['weightId'], baselineWeightId=config['baselineWeightId'],
                modelRevision=restored.config['revision'], baselineRevision=config['baselineRevision'],
                baseline=before, metrics=metrics, decision=decision, validationSnapshot=snapshot,
                splitIndices=[idx.tolist() for idx in indices], testReserved=len(indices[2]),
                ignoredChannels=payload.get('ignored_channels', []), history=history, historyCounts=history_counts,
                epochs=config['epochs'], lr=config['lr'], seed=config['seed'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    args = parser.parse_args()
    backend = Path(__file__).resolve().parents[1] / 'embedded' / 'ncc'
    sys.path[:0] = [str(backend / 'src'), str(backend / 'scripts')]
    job_file = Path(args.job)
    job = json.loads(job_file.read_text(encoding='utf-8'))
    config = job['config']
    out = job_file.parent
    import numpy as np
    import h5py
    from bci_dayloop.data.hdf5_dataset import EEGHDF5
    from bci_dayloop.serving.smr_sessions import extract_all_labeled_windows, windows_to_hdf5

    if job['kind'] == 'export':
        if config.get('history'):
            for item in config['history']['rounds']:
                seal_recordings(item['sessions'], item['recordingManifest'])
        elif config.get('roundId'):
            seal_recordings(config['sessions'], config['recordingManifest'])
        window_sec = float(config.get('windowSec', 2))
        if window_sec not in (2, 4):
            raise ValueError('训练窗口只支持 2 秒或 4 秒')
        print(f'[export] extracting labeled {window_sec:g}s non-overlapping windows', flush=True)
        windows = extract_all_labeled_windows([Path(p) for p in config['sessions']], window_sec=window_sec, hop_sec=window_sec, label_source=config['labelSource'])
        kept = [w for w in windows if not w.padded]
        if config.get('backend') == 'eegnet':
            # ponytail: one first complete window per trial avoids duration bias;
            # longer-trial augmentation can be added within the same fixed split.
            trials = {}
            for window in kept:
                trials.setdefault((window.session_id, window.trial_index), window)
            kept = list(trials.values())
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
        if config.get('roundId') and session_groups:
            raise ValueError('自动 probing 要求所有训练试次带有稳定的试次编号')
        with h5py.File(target, 'a') as handle:
            handle.create_dataset('source_trial_ids', data=np.array([-1 if w.session_id in session_groups else w.trial_index for w in kept], dtype=np.int64))
            if config.get('roundId'):
                handle.attrs['acquisition_round_id'] = config['roundId']
                handle.attrs['subject_label'] = config['subjectLabel']
        dataset = EEGHDF5(target)
        loaded = dataset.load()
        if not np.isfinite(loaded['data']).all():
            raise ValueError('EEG 包含非有限数值，请先检查采集数据')
        report = {'kind': 'export', 'shape': list(loaded['data'].shape), 'sampleRate': dataset.metadata.sample_rate,
                  'classNames': dataset.metadata.class_names, 'counts': np.bincount(loaded['labels'], minlength=4).tolist(),
                  'sessions': dataset.sessions(), 'windowSec': window_sec, 'hopSec': window_sec, 'droppedPadded': sum(w.padded for w in windows),
                  'missingTrialIdSessions': sorted(session_groups)}
        if config.get('roundId'):
            report.update(roundId=config['roundId'], subjectLabel=config['subjectLabel'])
        if config.get('history'):
            report['history'] = config['history']
    else:
        import torch
        dataset = EEGHDF5(config['dataset'])
        loaded = dataset.load()
        meta = dataset.metadata
        if meta.class_names != ['left_hand', 'right_hand', 'tongue', 'rest'] or meta.unit != 'uV':
            raise ValueError('训练只接受 SMR 四类、单位 uV 的 H5')
        if set(loaded['labels'].tolist()) != {0, 1, 2, 3}:
            raise ValueError('数据必须包含左手、右手、舌头和休息四类')
        if config['splitBy'] == 'session':
            groups = loaded['session_ids'].tolist()
        else:
            with h5py.File(config['dataset'], 'r') as handle:
                source_trials = handle['source_trial_ids'][:]
            groups = [f'{s}:{t}' for s, t in zip(loaded['session_ids'], source_trials)]
        adaptive = bool(config.get('roundId'))
        lora = job['kind'] == 'lora'
        history_counts = None
        snapshot = None
        if adaptive:
            try:
                if lora or job['kind'] == 'finetune':
                    for item in config['history']['rounds']:
                        seal_recordings(item['sessions'], item['recordingManifest'])
                    indices, snapshot, history_counts = history_split(loaded['labels'], groups, loaded['session_ids'], config['history'])
                else:
                    indices, snapshot = fixed_split(loaded['labels'], groups, config['splitLedger'], config['seed'])
            except InsufficientTrials as error:
                save_report(out, {'kind': job['kind'], 'skipped': True, 'reason': str(error)})
                print(str(error), flush=True)
                return
        else:
            indices = grouped_split(loaded['labels'], groups, config['seed'])
        print('[fit] grouped train/validation/test sizes:', [len(i) for i in indices], flush=True)
        if config.get('backend') == 'eegnet':
            report = fit_eegnet(out, job, loaded, meta, indices, snapshot, history_counts)
            save_report(out, report)
            print(json.dumps(report, ensure_ascii=True), flush=True)
            return
        from bci_dayloop.serving.reve import ReveModelBackend, default_checkpoint_root
        from fit_smr_control_head import encode_windows, train_linear_head
        torch.manual_seed(config['seed'])
        root = default_checkpoint_root()
        backend = ReveModelBackend(model_dir=root / ('reve-' + config['size']), positions_dir=root / 'reve-positions',
                                   device=config['device'], strategy='none', task='smr_control',
                                   state_file=Path(config['baselineStateFile']) if config.get('baselineStateFile') else None,
                                   cache_size=max(128, len(loaded['labels']) + 8),
                                   lora_checkpoint=Path(config['loraCheckpoint']) if config['loraCheckpoint'] else None)
        backend.load()
        duration = loaded['data'].shape[-1] / meta.sample_rate
        if abs(duration - backend.window_sec) > 1 / meta.sample_rate:
            raise ValueError(f'训练数据窗口 {duration:g} 秒与模型窗口 {backend.window_sec:g} 秒不一致')
        if adaptive and backend.model_revision != config['baselineRevision']:
            raise ValueError('离线载入的基线与采集模型版本不一致，拒绝比较')
        windows = [SimpleNamespace(data=data, class_id=int(label), sample_rate=meta.sample_rate,
                                   channel_names=tuple(meta.channel_names), session_id=str(session))
                   for data, label, session in zip(loaded['data'], loaded['labels'], loaded['session_ids'])]
        # The held-out test block is never encoded or scored during adaptive selection.
        if adaptive:
            usable = indices[1] if lora else np.concatenate(indices[:2])
            features, labels = encode_windows(backend, [windows[i] for i in usable])
            train = torch.arange(len(indices[0]), device=labels.device)
            val = torch.arange(len(usable), device=labels.device) if lora else torch.arange(len(indices[0]), len(usable), device=labels.device)
            baseline = classification_metrics(backend._head, features[val], labels[val])
            baseline_head = Path(config['baselineOutput'])
            baseline_head.parent.mkdir(parents=True, exist_ok=True)
            baseline_payload = {'head': {key: value.detach().cpu().clone() for key, value in backend._head.state_dict().items()},
                                'class_names': meta.class_names,
                                'head_initialization': getattr(backend, 'head_initialization', None),
                                'task': 'smr_control', 'encoder_id': backend.encoder_id, 'model_revision': backend.model_revision,
                                'feature_normalization': backend.feature_normalization, 'input_clip': backend.input_clip,
                                'preprocessing_profile': backend.preprocessing_profile,
                                'input_channel_names': list(backend.input_channel_names),
                                'input_window_sec': backend.window_sec,
                                'lora_checkpoint': config['loraCheckpoint'], 'size': config['size']}
            with baseline_head.open('xb') as handle:
                torch.save(baseline_payload, handle)
            if lora:
                from round_lora import train_round_lora
                del features, labels
                backend._cache.clear()
                metrics, lora_report = train_round_lora(backend, windows, indices[0], indices[1], config)
            else:
                balanced_probe(backend._head, features[train], labels[train], features[val], labels[val],
                               config['epochs'], config['lr'], config['seed'])
                metrics = {name: classification_metrics(backend._head, features[idx], labels[idx])
                           for name, idx in (('train', train), ('validation', val))}
            decision = promotion_decision(baseline, metrics['validation'], config['minimumGain'], config['maximumRecallDrop'])
        else:
            features, labels = encode_windows(backend, windows)
            train, val, test = [torch.tensor(idx, device=labels.device) for idx in indices]
            train_linear_head(backend._head, features[train], labels[train], epochs=config['epochs'], lr=config['lr'],
                              val_features=features[val], val_labels=labels[val], reset=True)
            metrics = {name: classification_metrics(backend._head, features[idx], labels[idx])
                       for name, idx in (('train', train), ('validation', val), ('test', test))}
        head = out / 'head.pt'
        revision = ('web-lora-' if lora else 'web-lp-') + job['id']
        encoder_id = Path(config['adapterOutput']).parent.name if lora else backend.encoder_id
        # File handles avoid older PyTorch's Windows non-ASCII path limitation.
        with head.open('wb') as handle:
            torch.save({'head': {key: value.detach().cpu() for key, value in backend._head.state_dict().items()},
                        'class_names': meta.class_names,
                        'head_initialization': getattr(backend, 'head_initialization', None),
                        'task': 'smr_control', 'encoder_id': encoder_id, 'step': config['epochs'],
                        'feature_normalization': getattr(backend, 'feature_normalization', 'l2'),
                        'input_clip': getattr(backend, 'input_clip', None),
                        'preprocessing_profile': getattr(backend, 'preprocessing_profile', None),
                        'input_channel_names': list(getattr(backend, 'input_channel_names', ())),
                        'input_window_sec': getattr(backend, 'window_sec', loaded['data'].shape[-1] / meta.sample_rate),
                        'lora_checkpoint': config['adapterOutput'] if lora else config['loraCheckpoint'], 'size': config['size'],
                        'trained_at': datetime.now(timezone.utc).isoformat(),
                        'model_revision': revision}, handle)
        published = Path(config['headOutput'])
        published.parent.mkdir(parents=True, exist_ok=True)
        if published.exists():
            raise FileExistsError('产物已存在，拒绝覆盖：' + str(published))
        shutil.copy2(head, published)
        report = {'kind': job['kind'], 'encoderId': encoder_id, 'headId': published.name, 'classNames': meta.class_names,
                  'metrics': metrics, 'splitBy': config['splitBy'], 'splitIndices': [idx.tolist() for idx in indices],
                  'dataset': config['dataset'], 'seed': config['seed'], 'epochs': config['epochs'], 'lr': config['lr']}
        if adaptive:
            report.update(baseline=baseline, baselineHeadId=baseline_head.name, baselineRevision=config['baselineRevision'],
                          modelRevision=revision, validationSnapshot=snapshot,
                          decision=decision, sampling='equal-class-with-replacement', testReserved=len(indices[2]))
        if lora:
            report.update(lora=lora_report, historyCounts=history_counts, skippedHistory=config['history']['skipped'],
                          adapterCheckpoint=config['adapterOutput'])
    save_report(out, report)
    print(json.dumps(report, ensure_ascii=True), flush=True)
    print('[done] artifacts saved', flush=True)


if __name__ == '__main__':
    main()
