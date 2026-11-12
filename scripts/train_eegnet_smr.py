"""Offline EEGNet linear probe followed by full fine-tuning on saved SMR trials."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

from serve_eegnet_tetris import fit_window, load_model


TARGET_LABELS = {
    'left': 'left_hand', 'right': 'right_hand', 'up': 'tongue', 'down': 'rest',
}


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def prepare_dataset(sessions, model, out):
    """Freeze complete received-sample windows inside actual feedback boundaries."""
    windows, labels, groups, manifest = [], [], [], []
    names = list(model.config['class_names'])
    samples = model.config['samples']
    expected_channels = model.config['channels']
    subject = None
    montage = None
    for folder in sessions:
        folder = Path(folder)
        session = read_json(folder / 'session.json')
        meta = read_json(folder / 'eeg.json')
        if session.get('status') != 'complete' or meta.get('status') != 'complete':
            raise ValueError(f'{folder.name}: recording is not complete')
        if subject is None:
            subject = session.get('subjectId')
            montage = meta.get('channelNames')
        if not subject or session.get('subjectId') != subject or meta.get('channelNames') != montage:
            raise ValueError('Sessions must belong to one subject with identical channel order')
        if (meta.get('channels') != expected_channels or meta.get('sampleRate') != model.config['sample_rate']
                or meta.get('unit') != 'uV' or meta.get('layout') != 'sample-major'
                or meta.get('dtype') != 'float32' or meta.get('endian') != 'le'):
            raise ValueError(f'{folder.name}: EEG format does not match the checkpoint')
        raw = np.fromfile(folder / 'eeg.bin', dtype='<f4')
        if raw.size % expected_channels:
            raise ValueError(f'{folder.name}: incomplete sample row')
        raw = raw.reshape(-1, expected_channels)
        stop = int(meta['clock']['sampleIndex'])
        origin = stop - len(raw)
        events = [json.loads(line) for line in (folder / 'events.jsonl').read_text(encoding='utf-8').splitlines()
                  if line.strip()]
        starts = {}
        complete_runs = {e['data']['run'] for e in events
                         if e.get('type') == 'group_end' and e.get('data', {}).get('complete') is True}
        if any(e.get('type') == 'group_interrupted' for e in events):
            raise ValueError(f'{folder.name}: interrupted group')
        initial = next(e for e in events if e.get('type') in ('session_start', 'group_start'))
        if int(initial['eeg']['sampleIndex']) != origin:
            raise ValueError(f'{folder.name}: file origin does not match the acquisition event')
        for event in events:
            if event.get('type') == 'feedback_start':
                key = (event['data']['run'], event['data']['index'])
                if key in starts:
                    raise ValueError(f'{folder.name}: duplicate feedback boundary')
                starts[key] = int(event['eeg']['sampleIndex'])
            if event.get('type') != 'trial':
                continue
            data = event['data']
            key = (data['run'], data['index'])
            if data.get('valid') is False or data.get('run') not in complete_runs:
                raise ValueError(f'{folder.name}: invalid or incomplete trial')
            label = TARGET_LABELS.get(data.get('target'))
            if not label or data.get('className') != label or label not in names:
                raise ValueError(f'{folder.name}: ambiguous or incompatible imagery label')
            start = starts[key]
            end = int(event['eeg']['sampleIndex'])
            if not origin <= start < end <= stop:
                raise ValueError(f'{folder.name}: invalid trial sample boundaries')
            group = f'{folder.name}:{key[0]}:{key[1]}'
            # Work backwards so transition samples at feedback onset are omitted.
            ends = list(range(end, start + samples - 1, -samples))[::-1]
            for window_end in ends:
                window_start = window_end - samples
                x = raw[window_start - origin:window_end - origin].T.copy()
                if x.shape != (expected_channels, samples) or not np.isfinite(x).all():
                    raise ValueError(f'{group}: malformed or non-finite window')
                windows.append(x)
                labels.append(names.index(label))
                groups.append(group)
                manifest.append(dict(group=group, label=label, start=window_start, end=window_end,
                                     feedback_start=start, feedback_end=end))
    if not windows:
        raise ValueError('No complete EEG windows inside labeled feedback intervals')
    x = np.stack(windows).astype('<f4')
    y = np.asarray(labels, dtype=np.int64)
    groups = np.asarray(groups)
    if len(set(y.tolist())) < 2:
        raise ValueError('At least two observed classes are required')
    # Deterministic chronological holdouts within each class; never split a trial.
    subsets = {'train': [], 'validation': [], 'test': []}
    for label in sorted(set(y.tolist())):
        ordered = list(dict.fromkeys(groups[y == label].tolist()))
        if len(ordered) < 5:
            raise ValueError(f'{names[label]}: need at least five independent trials')
        held = max(1, len(ordered) // 5)
        subsets['train'].extend(ordered[:-2 * held])
        subsets['validation'].extend(ordered[-2 * held:-held])
        subsets['test'].extend(ordered[-held:])
    indices = {key: np.flatnonzero(np.isin(groups, value)) for key, value in subsets.items()}
    np.savez_compressed(out / 'dataset.npz', x=x, y=y, groups=groups, **indices)
    dataset_report = dict(
        subject=subject, sessions=[str(Path(s).resolve()) for s in sessions],
        class_names=names, observed_class_names=[names[i] for i in sorted(set(y.tolist()))],
        channel_names=montage, shape=list(x.shape), sample_timing='received_samples',
        source_gap_localization='unavailable; do not assume continuous wall-clock EEG',
        split_groups=subsets, windows=manifest,
    )
    (out / 'dataset.json').write_text(json.dumps(dataset_report, indent=2), encoding='utf-8')
    return x, y, groups, indices, dataset_report


def trial_metrics(model, inputs, labels, groups, indices):
    model.eval()
    with torch.no_grad():
        logits = model(inputs[indices])
        probabilities = logits.softmax(dim=1).cpu().numpy()
    truth, predictions, losses = [], [], []
    subset_groups = groups[indices]
    for group in dict.fromkeys(subset_groups.tolist()):
        mask = subset_groups == group
        targets = labels[indices][mask]
        if len(set(targets.tolist())) != 1:
            raise ValueError('A trial has conflicting labels')
        target = int(targets[0])
        p = probabilities[mask].mean(axis=0)
        truth.append(target)
        predictions.append(int(p.argmax()))
        losses.append(-float(np.log(max(float(p[target]), 1e-12))))
    truth, predictions = np.asarray(truth), np.asarray(predictions)
    classes = sorted(set(truth.tolist()))
    recall = {model.config['class_names'][c]: float(np.mean(predictions[truth == c] == c))
              for c in classes}
    return dict(balanced_accuracy=float(np.mean(list(recall.values()))),
                accuracy=float(np.mean(truth == predictions)), negative_log_likelihood=float(np.mean(losses)),
                trials=len(truth), recalls=recall, truth=truth.tolist(), predictions=predictions.tolist())


def state_hash(state):
    h = hashlib.sha256()
    for name, tensor in sorted(state.items()):
        h.update(name.encode())
        h.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return h.hexdigest()


def train_stage(model, inputs, labels, groups, indices, *, stage, epochs, lr, seed):
    torch.manual_seed(seed)
    for parameter in model.encoder.parameters():
        parameter.requires_grad_(stage == 'ft')
    for parameter in model.classifier.parameters():
        parameter.requires_grad_(True)
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=lr)
    target = torch.as_tensor(labels, dtype=torch.long)
    rng = np.random.default_rng(seed)
    # Include the starting state as a candidate; validation never forces degradation.
    best = copy.deepcopy(model.state_dict())
    best_metrics = trial_metrics(model, inputs, labels, groups, indices['validation'])
    best_epoch = 0
    for epoch in range(1, epochs + 1):
        if stage == 'ft':
            model.train()
        else:
            # Frozen BatchNorm statistics and dropout matter as much as frozen gradients.
            model.eval()
            model.classifier.train()
        order = rng.permutation(indices['train'])
        for offset in range(0, len(order), 16):
            batch = order[offset:offset + 16]
            optimizer.zero_grad(set_to_none=True)
            loss = nn.functional.cross_entropy(model(inputs[batch]), target[batch])
            if not torch.isfinite(loss):
                raise ValueError('Non-finite training loss')
            loss.backward()
            optimizer.step()
        metrics = trial_metrics(model, inputs, labels, groups, indices['validation'])
        rank = (metrics['balanced_accuracy'], -metrics['negative_log_likelihood'])
        previous = (best_metrics['balanced_accuracy'], -best_metrics['negative_log_likelihood'])
        if rank > previous:
            best, best_metrics, best_epoch = copy.deepcopy(model.state_dict()), metrics, epoch
    model.load_state_dict(best, strict=True)
    model.eval()
    return dict(epochs=epochs, learning_rate=lr, selected_epoch=best_epoch,
                validation=best_metrics, encoder_hash=state_hash(model.encoder.state_dict()),
                classifier_hash=state_hash(model.classifier.state_dict()))


def save_checkpoint(model, original, destination, stage, dataset):
    payload = dict(original)
    payload.update(state_dict=copy.deepcopy(model.state_dict()), init=stage, task='smr_control',
                   channel_names=dataset['channel_names'], trained_class_names=dataset['observed_class_names'],
                   sample_timing='received_samples', training_split='chronological_by_trial_within_class')
    with destination.open('xb') as stream:
        torch.save(payload, stream)
    return str(destination.resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions', nargs='+', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seed', type=int, default=20261022)
    parser.add_argument('--lp-epochs', type=int, default=100)
    parser.add_argument('--ft-epochs', type=int, default=20)
    parser.add_argument('--lp-lr', type=float, default=.001)
    parser.add_argument('--ft-lr', type=float, default=.0001)
    parser.add_argument('--minimum-gain', type=float, default=.02)
    parser.add_argument('--maximum-recall-drop', type=float, default=0.)
    args = parser.parse_args()
    if not 0 <= args.minimum_gain <= 1 or not 0 <= args.maximum_recall_drop <= 1:
        raise ValueError('Promotion thresholds must be in 0..1')
    if not 1 <= args.lp_epochs <= 5000 or not 1 <= args.ft_epochs <= 500:
        raise ValueError('Epoch count is out of range')
    if not 0 < args.lp_lr <= 1 or not 0 < args.ft_lr <= .01:
        raise ValueError('Learning rate is out of range')
    if args.output.exists():
        raise ValueError('Output directory already exists; choose a new run directory')
    torch.set_num_threads(1)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    # No network calls, service controls, CUDA allocation, or in-place weight updates.
    original = torch.load(args.checkpoint, map_location='cpu', weights_only=True)
    model = load_model(args.checkpoint)
    args.output.mkdir(parents=True)
    x, y, groups, indices, dataset = prepare_dataset(args.sessions, model, args.output)
    tensors = [fit_window(model, dict(channels=model.config['channels'], samples=model.config['samples'],
                                     sample_rate=model.config['sample_rate'], unit='uV', layout='CT'),
                          window.tobytes()) for window in x]
    inputs = torch.cat(tensors)
    report = dict(
        baseline_checkpoint=str(args.checkpoint.resolve()), baseline_revision=model.config['revision'],
        seed=args.seed, dataset=dataset,
        baseline_encoder_hash=state_hash(model.encoder.state_dict()),
        baseline_classifier_hash=state_hash(model.classifier.state_dict()),
        baseline_validation=trial_metrics(model, inputs, y, groups, indices['validation']),
        limitation='Observed classes only; unseen output classes are not evaluated. Small single-session holdout.',
    )
    stages = {}
    states = {}
    for stage, epochs, lr in [('lp', args.lp_epochs, args.lp_lr), ('ft', args.ft_epochs, args.ft_lr)]:
        metrics = train_stage(model, inputs, y, groups, indices, stage=stage, epochs=epochs, lr=lr, seed=args.seed)
        path = args.output / ('linear_probe.pt' if stage == 'lp' else 'fine_tuned.pt')
        metrics['checkpoint'] = save_checkpoint(model, original, path, stage, dataset)
        stages[stage], states[stage] = metrics, copy.deepcopy(model.state_dict())
        print(f'[{stage}] validation={metrics["validation"]["balanced_accuracy"]:.3f} epoch={metrics["selected_epoch"]}',
              flush=True)
    # Lock recommendation using validation only, before inspecting the held-out test.
    def rank(stage):
        v = stages[stage]['validation']
        return v['balanced_accuracy'], -v['negative_log_likelihood']
    selected = 'ft' if rank('ft') > rank('lp') else 'lp'
    report.update(stages=stages, recommended_stage=selected, recommended_checkpoint=stages[selected]['checkpoint'])
    for stage in ('lp', 'ft'):
        model.load_state_dict(states[stage], strict=True)
        stages[stage]['test'] = trial_metrics(model, inputs, y, groups, indices['test'])
    # Reload both artifacts through the production loader; inference contract stays unchanged.
    for stage in ('lp', 'ft'):
        restored = load_model(Path(stages[stage]['checkpoint']))
        assert list(restored.config['class_names']) == list(original['class_names'])
        assert state_hash(restored.state_dict()) == state_hash(states[stage])
        stages[stage]['revision'] = restored.config['revision']
    assert report['baseline_encoder_hash'] == stages['lp']['encoder_hash']
    # Promotion uses validation only; the held-out test is reported, never used to choose.
    base, chosen = report['baseline_validation'], stages[selected]['validation']
    gain = chosen['balanced_accuracy'] - base['balanced_accuracy']
    drop = max(base['recalls'][name] - chosen['recalls'].get(name, 0.0) for name in base['recalls'])
    # A random 4-class head scores below chance on a 2-class dataset; beating it is not learning.
    chance = 1 / len(dataset['observed_class_names'])
    promote = (gain >= args.minimum_gain and gain > 0 and drop <= args.maximum_recall_drop
               and chosen['balanced_accuracy'] > chance + args.minimum_gain)
    report['decision'] = dict(
        promote=promote, stage=selected, gain=gain, max_recall_drop=drop,
        minimum_gain=args.minimum_gain, maximum_recall_drop=args.maximum_recall_drop, chance=chance,
        checkpoint=stages[selected]['checkpoint'] if promote else report['baseline_checkpoint'],
        revision=stages[selected]['revision'] if promote else report['baseline_revision'],
        reason=(f'{selected.upper()} 验证平衡准确率提升 {gain * 100:.1f} 个百分点，接管' if promote
                else f'{selected.upper()} 验证 {chosen["balanced_accuracy"] * 100:.1f}%（随机水平 {chance * 100:.0f}%）、'
                     f'提升 {gain * 100:.1f} 个百分点、单类召回最多下降 {drop * 100:.1f} 个百分点，未达阈值，保留原模型'))
    (args.output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(f'[saved] {args.output.resolve() / "report.json"}', flush=True)


if __name__ == '__main__':
    main()
