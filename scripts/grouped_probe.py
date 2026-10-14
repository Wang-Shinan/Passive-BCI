"""Small, reproducible helpers for the grouped acquisition workflow."""
import hashlib
import json
from pathlib import Path


class InsufficientTrials(ValueError):
    pass


def seal_recordings(recordings, manifest_path):
    """Remember the exact files used by cumulative jobs; reject later edits."""
    path = Path(manifest_path)
    previous = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    current = {}
    for recording in recordings:
        folder = Path(recording)
        meta = json.loads((folder / 'eeg.json').read_text(encoding='utf-8'))
        if meta.get('format') != 'float32-le-interleaved' or meta.get('unit') != 'uV':
            raise ValueError('自动 probing 当前要求 float32、uV 录制格式')
        hashes = {}
        for name in ('eeg.bin', 'events.jsonl', 'eeg.json', 'session.json'):
            digest = hashlib.sha256()
            with (folder / name).open('rb') as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(chunk)
            hashes[name] = digest.hexdigest()
        current[folder.name] = hashes
    if any(current.get(key) != value for key, value in previous.items()):
        raise ValueError('已封存组的数据缺失或内容改变，拒绝重新划分／训练')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(current, indent=2), encoding='utf-8')
    temporary.replace(path)
    return current


def fixed_split(labels, groups, ledger_path, seed):
    """Reserve whole trials once; subsequent groups only extend training."""
    import numpy as np
    path = Path(ledger_path)
    if path.exists():
        ledger = json.loads(path.read_text(encoding='utf-8'))
        if ledger['seed'] != seed:
            raise ValueError('固定划分的随机种子发生变化')
        assignments = ledger['assignments']
        if not set(assignments).issubset(groups):
            raise ValueError('累计数据缺少已登记试次，拒绝改变验证快照')
    else:
        assignments = {}
        rng = np.random.default_rng(seed)
        for label in range(4):
            keys = sorted({g for g, y in zip(groups, labels) if y == label})
            if len(keys) < 3:
                raise InsufficientTrials('每类至少需要 3 个有效独立试次；本次跳过，继续采集')
            for key in keys:
                if len({int(y) for g, y in zip(groups, labels) if g == key}) != 1:
                    raise ValueError('同一试次包含冲突标签')
            order = rng.permutation(keys).tolist()
            held = max(1, len(keys) // 5)
            for index, key in enumerate(order):
                assignments[key] = 'validation' if index < held else 'test' if index < 2 * held else 'train'
    for key in groups:
        assignments.setdefault(key, 'train')
    indices = [np.array([i for i, key in enumerate(groups) if assignments[key] == role], dtype=int)
               for role in ('train', 'validation', 'test')]
    if any(set(labels[idx].tolist()) != {0, 1, 2, 3} for idx in indices):
        raise InsufficientTrials('固定划分中有类别缺失；本次不训练、不接管')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'seed': seed, 'assignments': assignments}, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)
    validation = sorted(key for key, role in assignments.items() if role == 'validation')
    snapshot = hashlib.sha256(json.dumps(validation).encode()).hexdigest()
    return indices, snapshot


def classification_metrics(head, features, labels):
    import torch
    with torch.no_grad():
        prediction = head(features).argmax(1)
        confusion = torch.bincount(labels * 4 + prediction, minlength=16).reshape(4, 4).cpu()
    recalls = confusion.diag().float() / confusion.sum(1).clamp_min(1)
    return {'count': len(labels), 'accuracy': float((prediction == labels).float().mean()),
            'balancedAccuracy': float(recalls.mean()), 'recalls': recalls.tolist(), 'confusion': confusion.tolist()}


def history_split(labels, groups, sessions, history):
    """Union existing per-round roles; never reassign a historical holdout to training."""
    import numpy as np
    result = [[], [], []]
    counts = []
    snapshots = []
    seen = set()
    for item in history['rounds']:
        names = {Path(folder).name for folder in item['sessions']}
        selected = np.array([i for i, session in enumerate(sessions) if str(session) in names], dtype=int)
        if seen.intersection(selected.tolist()):
            raise ValueError('历史数据中会话属于多个轮次')
        seen.update(selected.tolist())
        split, snapshot = fixed_split(labels[selected], [groups[i] for i in selected], item['splitLedger'], item['seed'])
        for target, indices in zip(result, split):
            target.extend(selected[indices].tolist())
        counts.append({'roundId': item['id'], 'windows': [len(idx) for idx in split],
                       'trainClassCounts': np.bincount(labels[selected[split[0]]], minlength=4).tolist()})
        snapshots.append([item['id'], snapshot])
    if seen != set(range(len(labels))):
        raise ValueError('历史数据包含未登记的会话')
    snapshot = hashlib.sha256(json.dumps(snapshots).encode()).hexdigest()
    return [np.array(idx, dtype=int) for idx in result], snapshot, counts


def balanced_probe(head, features, labels, val_features, val_labels, epochs, lr, seed):
    import torch
    torch.manual_seed(seed)
    torch.nn.init.zeros_(head.weight)
    torch.nn.init.zeros_(head.bias)
    optimizer = torch.optim.Adam(head.parameters(), lr=lr)
    classes = [(labels == label).nonzero().flatten() for label in range(4)]
    per_class = max(len(indices) for indices in classes)
    best_score, best = -1., None
    for _ in range(epochs):
        # Exactly equal counts per class, with replacement only in training.
        selected = torch.cat([idx[torch.randint(len(idx), (per_class,), device=idx.device)] for idx in classes])
        head.train()
        optimizer.zero_grad()
        loss = torch.nn.functional.cross_entropy(head(features[selected]), labels[selected])
        loss.backward()
        torch.nn.utils.clip_grad_norm_(head.parameters(), 1.)
        optimizer.step()
        head.eval()
        score = classification_metrics(head, val_features, val_labels)['balancedAccuracy']
        if score > best_score:
            best_score = score
            best = {key: value.detach().clone() for key, value in head.state_dict().items()}
    head.load_state_dict(best)
    head.eval()


def promotion_decision(current, candidate, minimum_gain, maximum_drop):
    gain = candidate['balancedAccuracy'] - current['balancedAccuracy']
    regressions = [old - new for old, new in zip(current['recalls'], candidate['recalls'])]
    promote = gain > minimum_gain and max(regressions) <= maximum_drop
    return {'promote': promote, 'gain': gain, 'minimumGain': minimum_gain, 'maximumRecallDrop': maximum_drop,
            'reason': '验证指标达到接管条件' if promote else '提升不足或单类召回下降，保留当前模型'}
