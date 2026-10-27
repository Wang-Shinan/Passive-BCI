"""Train an EEGNet LP and full fine-tune; reserve the last recording for final testing.

Uses the serving preprocessing and saves complete, directly loadable checkpoints.
Each trial contributes its first complete 2-second imagery window, regardless of
trial duration. The test recording never participates in fitting or selection.
"""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import torch
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'embedded/ncc/src'))
from bci_dayloop.serving.smr_sessions import extract_labeled_windows
from grouped_probe import seal_recordings
from serve_eegnet_tetris import CLASS_NAMES, fit_window, load_model


@torch.inference_mode()
def evaluate(model, inputs, labels, indices):
    model.eval()
    logits = model(inputs[indices]).cpu()
    truth = labels[indices].cpu()
    assert torch.isfinite(logits).all(), 'Non-finite model output'
    predicted = logits.argmax(1)
    confusion = torch.bincount(truth * 4 + predicted, minlength=16).reshape(4, 4)
    recalls = confusion.diag().float() / confusion.sum(1).clamp_min(1)
    return dict(count=len(indices), balancedAccuracy=recalls.mean().item(),
                accuracy=(truth == predicted).float().mean().item(), recalls=recalls.tolist(),
                loss=torch.nn.functional.cross_entropy(logits, truth).item(),
                confusion=confusion.tolist(), predictedCounts=torch.bincount(predicted, minlength=4).tolist(),
                labels=truth.tolist(), predictions=predicted.tolist())


def score(metrics):
    return metrics['balancedAccuracy'], -metrics['loss']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--recordings', type=Path, nargs='+', required=True,
                        help='Chronological recordings from one participant; last is held out')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=20261026)
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--patience', type=int, default=20)
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cuda')
    args = parser.parse_args()
    if len(args.recordings) < 3 or args.epochs < 1 or args.patience < 1:
        parser.error('At least three recordings and positive epochs/patience are required')
    if len({p.resolve() for p in args.recordings}) != len(args.recordings):
        parser.error('Recordings must be distinct')
    torch.set_num_threads(4)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    baseline = load_model(args.checkpoint)
    cfg = baseline.config
    if cfg['samples'] / cfg['sample_rate'] != 2:
        raise ValueError('This training recipe requires a 2-second checkpoint')
    manifests = [json.loads((p / 'session.json').read_text(encoding='utf-8')) for p in args.recordings]
    subjects = {m.get('subjectId') for m in manifests}
    if len(subjects) != 1 or not next(iter(subjects)):
        raise ValueError('Recordings must belong to one identified participant')
    if [m['startedAt'] for m in manifests] != sorted(m['startedAt'] for m in manifests):
        raise ValueError('Recordings must be supplied chronologically')
    windows, audit = [], []
    for folder, manifest in zip(args.recordings, manifests):
        if manifest['status'] != 'complete' or (folder / 'eeg.bin').stat().st_size != manifest['bytes']:
            raise ValueError(f'Incomplete recording: {folder}')
        meta = json.loads((folder / 'eeg.json').read_text(encoding='utf-8'))
        if meta['channels'] != cfg['channels'] or meta['unit'] != 'uV':
            raise ValueError(f'Incompatible channel count or units: {folder}')
        extracted = extract_labeled_windows(folder, window_sec=2, hop_sec=2, label_source='trial')
        trials = {}
        for window in extracted:
            if not window.padded:
                if window.trial_index in trials and trials[window.trial_index].class_id != window.class_id:
                    raise ValueError('Conflicting labels within a trial')
                trials.setdefault(window.trial_index, window)
        kept = list(trials.values())
        if {w.class_id for w in kept} != set(range(4)):
            raise ValueError(f'Every recording needs all four classes: {folder}')
        raw = np.stack([w.data for w in kept])
        if not np.isfinite(raw).all():
            raise ValueError(f'Non-finite EEG: {folder}')
        audit.append(dict(session=folder.name, sourceWindows=len(extracted), retainedTrials=len(kept),
                          classCounts=np.bincount([w.class_id for w in kept], minlength=4).tolist(),
                          flatWindowFraction=(np.ptp(raw, axis=2) < .1).mean(0).tolist(),
                          medianAbsUV=np.median(np.abs(raw), axis=(0, 2)).tolist()))
        windows.extend(kept)
    names = windows[0].channel_names
    if any(w.channel_names != names for w in windows):
        raise ValueError('Channel order changed between recordings')
    labels_np = np.array([w.class_id for w in windows], dtype=np.int64)
    test = np.array([i for i, w in enumerate(windows) if w.session_id == args.recordings[-1].name])
    development = np.setdiff1d(np.arange(len(windows)), test)
    train, validation = train_test_split(development, test_size=.2, stratify=labels_np[development], random_state=args.seed)
    splits = dict(train=np.sort(train), validation=np.sort(validation), test=test)
    assert not (set(train) & set(validation) or set(train) & set(test) or set(validation) & set(test))
    assert all(set(labels_np[idx]) == set(range(4)) for idx in splits.values())
    inputs = torch.cat([fit_window(baseline, dict(channels=w.data.shape[0], samples=w.data.shape[1],
                        sample_rate=w.sample_rate), w.data.astype('<f4').tobytes()) for w in windows]).to(args.device)
    labels = torch.tensor(labels_np, dtype=torch.long, device=args.device)
    args.output.mkdir(parents=True, exist_ok=False)
    seal_recordings(args.recordings, args.output / 'recordings.json')
    report = dict(subjectId=next(iter(subjects)), classes=list(CLASS_NAMES), audit=audit,
                  seed=args.seed, device=args.device, checkpoint=str(args.checkpoint.resolve()),
                  checkpointSha256=hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(),
                  servingSha256=hashlib.sha256((ROOT / 'scripts/serve_eegnet_tetris.py').read_bytes()).hexdigest(),
                  split={role:[dict(session=windows[i].session_id, trial=windows[i].trial_index,
                                    label=int(labels_np[i])) for i in idx] for role,idx in splits.items()},
                  protocol='one first complete 2s window per trial; last session is held-out test; validation selects model')
    print('[data] ' + json.dumps({role:len(idx) for role,idx in splits.items()}), flush=True)
    baseline.to(args.device).eval()
    baseline_validation = evaluate(baseline, inputs, labels, validation)
    lp = deepcopy(baseline)
    with torch.inference_mode():
        features = lp.encoder(inputs[train]).flatten(1).cpu().numpy()
    scaler = StandardScaler().fit(features)
    classifier = LogisticRegression(C=1., class_weight='balanced', max_iter=2000, random_state=args.seed)
    classifier.fit(scaler.transform(features), labels_np[train])
    assert classifier.classes_.tolist() == [0, 1, 2, 3]
    # Fold feature standardization into the linear head; serving needs no extra layer.
    weights = classifier.coef_ / scaler.scale_
    bias = classifier.intercept_ - weights @ scaler.mean_
    with torch.no_grad():
        lp.classifier.weight.copy_(torch.tensor(weights, dtype=torch.float32, device=args.device))
        lp.classifier.bias.copy_(torch.tensor(bias, dtype=torch.float32, device=args.device))
    assert all(torch.equal(a, b) for a, b in zip(lp.encoder.state_dict().values(), baseline.encoder.state_dict().values()))
    with torch.inference_mode():
        np.testing.assert_allclose(torch.softmax(lp(inputs[train]), 1).cpu().numpy(),
                                   classifier.predict_proba(scaler.transform(features)), atol=2e-4, rtol=2e-4)
    lp_validation = evaluate(lp, inputs, labels, validation)
    print('[lp] validation ' + json.dumps(lp_validation), flush=True)
    # Train the random backbone independently: LP's folded feature scaling is
    # incompatible with the changing BatchNorm statistics of a trainable encoder.
    fine = deepcopy(baseline)
    optimizer = torch.optim.AdamW(fine.parameters(), lr=1e-3, weight_decay=1e-4)
    best_state, best_metric, best_epoch = None, None, 0
    history = []
    generator = torch.Generator().manual_seed(args.seed)
    for epoch in range(1, args.epochs + 1):
        fine.train()
        order = torch.tensor(train)[torch.randperm(len(train), generator=generator)].tolist()
        for start in range(0, len(order), 16):
            idx = order[start:start + 16]
            optimizer.zero_grad(set_to_none=True)
            loss = torch.nn.functional.cross_entropy(fine(inputs[idx]), labels[idx], label_smoothing=.05)
            if not torch.isfinite(loss):
                raise ValueError('Non-finite training loss')
            loss.backward()
            torch.nn.utils.clip_grad_norm_(fine.parameters(), 1., error_if_nonfinite=True)
            optimizer.step()
        metrics = evaluate(fine, inputs, labels, validation)
        history.append(dict(epoch=epoch, balancedAccuracy=metrics['balancedAccuracy'], loss=metrics['loss']))
        if best_metric is None or score(metrics) > score(best_metric):
            best_state, best_metric, best_epoch = deepcopy(fine.state_dict()), metrics, epoch
        if epoch == 1 or epoch % 10 == 0:
            print(f'[finetune] epoch={epoch} validation_BA={metrics["balancedAccuracy"]:.3f} best_epoch={best_epoch}', flush=True)
        if epoch - best_epoch >= args.patience:
            break
    fine.load_state_dict(best_state)
    fine.eval()
    assert any(not torch.equal(a, b) for a, b in zip(fine.encoder.parameters(), baseline.encoder.parameters()))
    candidates = dict(baseline=baseline_validation, lp=lp_validation, finetune=best_metric)
    selected = max(candidates, key=lambda name: score(candidates[name]))
    report.update(selected=selected, selectedBeforeTest=True, bestEpoch=best_epoch, history=history, metrics={},
                  recipe=dict(lp='frozen encoder + standardized multinomial logistic regression, C=1',
                              finetune='original checkpoint; all parameters; AdamW lr=0.001; batch=16; label smoothing=0.05',
                              epochs=args.epochs, patience=args.patience),
                  selection='validation balanced accuracy, then lower cross entropy; baseline is eligible')
    # All model selection is finished before evaluating test scores.
    for name, model in (('baseline', baseline), ('lp', lp), ('finetune', fine)):
        report['metrics'][name] = {role:evaluate(model, inputs, labels, idx) for role,idx in splits.items()}
        if name == 'baseline':
            continue
        payload = dict(architecture='eegnet', init=name, n_channels=cfg['channels'], n_samples=cfg['samples'],
                       sample_rate=cfg['sample_rate'], window_sec=2, normalization='per-channel-zscore',
                       normalization_version='dc-centered-v2', class_names=list(CLASS_NAMES), channel_names=list(names),
                       ignored_channels=cfg['ignored_channels'],
                       subject_id=report['subjectId'], trained_at=datetime.now(timezone.utc).isoformat(),
                       state_dict={key:value.detach().cpu() for key,value in model.state_dict().items()})
        target = args.output / f'{name}.pt'
        with target.open('xb') as stream:
            torch.save(payload, stream)
        restored = load_model(target).to(args.device)
        with torch.inference_mode():
            torch.testing.assert_close(restored(inputs[test]), model(inputs[test]), rtol=0, atol=0)
    seal_recordings(args.recordings, args.output / 'recordings.json')
    (args.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[done] ' + json.dumps(dict(selected=selected, bestEpoch=best_epoch,
          metrics={name:{role:round(m['balancedAccuracy'],4) for role,m in roles.items()}
                   for name,roles in report['metrics'].items()})), flush=True)


if __name__ == '__main__':
    main()
