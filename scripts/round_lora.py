"""Joint residual LoRA + SMR head training, using the serving preprocessing and checkpoint format."""
from pathlib import Path
import math


def train_round_lora(backend, windows, train_indices, val_indices, config, *, pair_costs=None, cover_all=False):
    import numpy as np
    import torch
    from peft import LoraConfig, get_peft_model
    from grouped_probe import classification_metrics

    torch.manual_seed(config['seed'])
    # backend already contains the exact current encoder (including any previous adapter).
    # New LoRA learns a residual on that frozen starting point; save the full PEFT state
    # so serving can reconstruct it from the base without a chain of adapter dependencies.
    model = get_peft_model(backend._model, LoraConfig(r=config['rank'], lora_alpha=config['alpha'],
                          target_modules=['to_qkv', 'to_out'], lora_dropout=0., bias='none'))
    head = backend._head
    backend._pos_bank.requires_grad_(False)
    head.requires_grad_(True)
    parameters = [p for p in model.parameters() if p.requires_grad] + list(head.parameters())
    optimizer = torch.optim.AdamW(parameters, lr=config['lr'], weight_decay=0.)
    device = backend._torch_device
    if device.type == 'cuda':
        torch.cuda.reset_peak_memory_stats(device)
    positions = {}
    adjustments = None
    if pair_costs:
        adjustments = torch.zeros((head.out_features, head.out_features), device=device)
        for (actual, predicted), cost in pair_costs.items():
            adjustments[actual, predicted] = math.log(cost)

    def features(indices):
        inputs = []
        canonical = None
        coordinates = None
        for index in indices:
            item = windows[int(index)]
            data, channel_names, supplied = backend.project_model_electrodes(
                item.data, item.channel_names, item.electrode_positions,
            )
            prepared, names = backend.prepare_input(data, channel_names, item.sample_rate,
                                                   electrode_positions=supplied)
            if canonical is not None and (tuple(names) != canonical or supplied != coordinates):
                raise ValueError('同一批次的导联不一致')
            canonical = tuple(names)
            coordinates = supplied
            inputs.append(torch.from_numpy(np.ascontiguousarray(prepared)))
        layout = (canonical, coordinates)
        if layout not in positions:
            with torch.no_grad():
                pos = (torch.tensor(coordinates, dtype=torch.float32, device=device)
                       if coordinates is not None and backend.preprocessing_profile is None
                       else backend._pos_bank(list(canonical)).to(device).detach())
                positions[layout] = pos.unsqueeze(0) if pos.ndim == 2 else pos
        eeg = torch.stack(inputs).to(device, dtype=torch.float32)
        tokens = model(eeg, positions[layout].expand(len(inputs), -1, -1))
        pooled = model.base_model.model.attention_pooling(tokens)
        return torch.nn.functional.normalize(pooled, dim=-1) if backend.feature_normalization == 'l2' else pooled

    def evaluate(indices):
        model.eval(); head.eval()
        with torch.no_grad():
            # Only logits are retained; all raw EEG and activations are transferred batchwise.
            logits = torch.cat([head(features(indices[start:start + config['batchSize']])).cpu()
                                for start in range(0, len(indices), config['batchSize'])])
        labels = torch.tensor([windows[int(i)].class_id for i in indices])
        return classification_metrics(torch.nn.Identity(), logits, labels)

    labels = np.array([windows[int(i)].class_id for i in train_indices])
    classes = [np.asarray(train_indices)[labels == label] for label in range(4)]
    if any(len(indices) == 0 for indices in classes):
        raise ValueError('LoRA 训练集必须包含四类')
    fixed_epochs = val_indices is None
    rng = np.random.default_rng(config['seed'])
    best_score, best, best_epoch = -1., None, 0
    batch_size, accumulation = config['batchSize'], config['accumulationSteps']
    for epoch in range(config['epochs']):
        per_class = max(map(len, classes))
        if fixed_epochs or cover_all:
            # Retain every training window, oversampling only to balance minority classes.
            selected = np.concatenate([
                np.concatenate((indices, rng.choice(indices, per_class - len(indices), replace=True)))
                for indices in classes
            ])
        else:
            selected = np.concatenate([rng.choice(indices, per_class, replace=True) for indices in classes])
        rng.shuffle(selected)
        batches = math.ceil(len(selected) / batch_size)
        model.train(); head.train()
        for step, start in enumerate(range(0, len(selected), batch_size)):
            if step % accumulation == 0:
                optimizer.zero_grad(set_to_none=True)
            indices = selected[start:start + batch_size]
            targets = torch.tensor([windows[int(i)].class_id for i in indices], device=device)
            logits = head(features(indices))
            if adjustments is not None:
                logits = logits + adjustments[targets]
            loss = torch.nn.functional.cross_entropy(logits, targets)
            if not torch.isfinite(loss):
                raise ValueError('LoRA loss 非有限，停止训练')
            # Weight a short final microbatch by its sample count as well.
            group_start = (step // accumulation) * accumulation * batch_size
            group_size = min(accumulation * batch_size, len(selected) - group_start)
            (loss * len(indices) / group_size).backward()
            if (step + 1) % accumulation == 0 or step + 1 == batches:
                torch.nn.utils.clip_grad_norm_(parameters, 1., error_if_nonfinite=True)
                optimizer.step()
        if fixed_epochs:
            print(f'[lora] epoch {epoch + 1}/{config["epochs"]} trained on {len(selected)} windows', flush=True)
            continue
        score = evaluate(val_indices)['balancedAccuracy']
        print(f'[lora] epoch {epoch + 1}/{config["epochs"]} validation_BA={score:.4f}', flush=True)
        if score > best_score:
            best_score, best_epoch = score, epoch + 1
            best = ({name: p.detach().cpu().clone() for name, p in model.named_parameters() if p.requires_grad},
                    {name: value.detach().cpu().clone() for name, value in head.state_dict().items()})
    if best is not None:
        with torch.no_grad():
            for name, parameter in model.named_parameters():
                if name in best[0]:
                    parameter.copy_(best[0][name])
        head.load_state_dict(best[1])
    metrics = {'train': evaluate(train_indices)}
    if not fixed_epochs:
        metrics['validation'] = evaluate(val_indices)
    adapter = Path(config['adapterOutput'])
    adapter.parent.mkdir(parents=True, exist_ok=True)
    state = {'encoder.backbone.' + key: value.detach().cpu() for key, value in model.state_dict().items()}
    state.update({'head.fc.' + key: value.detach().cpu() for key, value in head.state_dict().items()})
    with adapter.open('xb') as handle:
        torch.save({'model': state, 'meta': {'lora': {'rank': config['rank'], 'alpha': config['alpha']},
                   'label_names': ['left_hand', 'right_hand', 'tongue', 'rest'],
                   'initialRevision': config['baselineRevision'], 'initialAdapter': config['loraCheckpoint'],
                   'feature_normalization': backend.feature_normalization, 'input_clip': backend.input_clip,
                   'preprocessing_profile': backend.preprocessing_profile,
                   'input_channel_names': list(backend.input_channel_names),
                   **({'required_electrodes': list(backend.required_electrodes)} if backend.required_electrodes else {}),
                   'input_window_sec': backend.window_sec}}, handle)
    return metrics, {'bestEpoch': config['epochs'] if fixed_epochs else best_epoch, 'rank': config['rank'], 'alpha': config['alpha'],
                     'targets': ['to_qkv', 'to_out'], 'batchSize': batch_size, 'accumulationSteps': accumulation,
                     'trainableParameters': sum(p.numel() for p in parameters),
                     'peakAllocatedMiB': torch.cuda.max_memory_allocated(device) / 2**20 if device.type == 'cuda' else None,
                     'initialRevision': config['baselineRevision'], 'initialAdapter': config['loraCheckpoint'],
                     'initialHead': config.get('baselineStateFile'), 'device': str(device)}
