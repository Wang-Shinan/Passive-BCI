from __future__ import annotations

import argparse
from collections import Counter
from io import BytesIO
from pathlib import Path
import sys

import torch
from torch import nn
import torch.nn.functional as F

from _bootstrap import ROOT  # noqa: F401
from bci_dayloop.serving.protocol import ParsedWindow
from bci_dayloop.serving.reve import (
    ReveModelBackend,
    SMR_CONTROL_CLASS_NAMES,
    default_checkpoint_root,
    init_linear_head,
)
from bci_dayloop.serving.reve_lora import default_stieger_lora_checkpoint, lora_state_stem
from bci_dayloop.serving.smr_sessions import discover_smr_recordings, extract_all_labeled_windows
from bci_dayloop.serving.profiles import REVE_TARGET_HZ


def default_recordings_root() -> Path:
    sibling = ROOT.parents[1] / "recordings"
    if sibling.is_dir():
        return sibling
    return Path.cwd() / "recordings"


def default_state_file(recordings: Path, encoder_id: str = "reve-base") -> Path:
    return recordings / ".reve-heads" / f"{lora_state_stem(encoder_id)}_tongue.pt"


def encode_windows(backend: ReveModelBackend, windows) -> tuple[torch.Tensor, torch.Tensor]:
    features: list[torch.Tensor] = []
    labels: list[int] = []
    if windows:
        src_hz = float(windows[0].sample_rate)
        src_samples = int(windows[0].data.shape[1])
        window_sec = float(backend.window_sec)
        dst_samples = int(round(window_sec * REVE_TARGET_HZ))
        print(
            f"[fit-smr] resample {src_hz:g} Hz × {src_samples} samples "
            f"-> {REVE_TARGET_HZ:g} Hz × {dst_samples} samples ({window_sec:g}s)"
        )
        if abs(src_hz - REVE_TARGET_HZ) < 1e-6:
            print("[fit-smr] source already at REVE target Hz")
    for i, item in enumerate(windows):
        prediction = backend.predict(
            ParsedWindow(
                request_id=f"fit-encode-{i}",
                window_id=i,
                segment_id=item.session_id,
                sample_rate=item.sample_rate,
                channel_names=item.channel_names,
                channels=int(item.data.shape[0]),
                samples=int(item.data.shape[1]),
                start_time_sec=None,
                end_time_sec=None,
                data=item.data,
                profile=None,
            )
        )
        cached = backend._cache.get(prediction.observation_id)
        if cached is None:
            raise SystemExit(f"missing cached features for {prediction.observation_id}")
        features.append(cached.detach())
        labels.append(item.class_id)
        if (i + 1) % 10 == 0 or i + 1 == len(windows):
            print(f"[fit-smr] encoded {i + 1}/{len(windows)}")
    return torch.cat(features, dim=0), torch.tensor(labels, device=features[0].device, dtype=torch.long)


def train_linear_head(
    head: nn.Linear,
    features: torch.Tensor,
    labels: torch.Tensor,
    *,
    epochs: int,
    lr: float,
    class_indices: list[int] | None = None,
    val_features: torch.Tensor | None = None,
    val_labels: torch.Tensor | None = None,
    reset: bool = True,
) -> None:
    if reset:
        init_linear_head(head)
    n_out = len(class_indices) if class_indices is not None else head.out_features
    counts = torch.bincount(labels, minlength=n_out).float()
    weights = (counts.clamp_min(1).sum() / (counts.clamp_min(1) * len(counts))).to(features.device)
    optimizer = torch.optim.Adam(head.parameters(), lr=lr)
    best_state: dict[str, torch.Tensor] | None = None
    best_val = -1.0
    head.train()
    for epoch in range(epochs):
        optimizer.zero_grad(set_to_none=True)
        logits = select_logits(head(features), class_indices)
        loss = F.cross_entropy(logits, labels, weight=weights)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
        optimizer.step()
        train_acc = float((logits.argmax(dim=1) == labels).float().mean())
        val_acc = None
        if val_features is not None and val_labels is not None:
            head.eval()
            with torch.no_grad():
                val_logits = select_logits(head(val_features), class_indices)
                val_acc = float((val_logits.argmax(dim=1) == val_labels).float().mean())
            head.train()
            if val_acc >= best_val:
                best_val = val_acc
                best_state = {key: value.detach().clone() for key, value in head.state_dict().items()}
        if (epoch + 1) % max(1, epochs // 8) == 0 or epoch + 1 == epochs:
            extra = f" val_acc={val_acc:.1%}" if val_acc is not None else ""
            print(f"[fit-smr] epoch {epoch + 1}/{epochs} loss={float(loss):.4f} acc={train_acc:.1%}{extra}")
    if best_state is not None:
        head.load_state_dict(best_state)
        print(f"[fit-smr] restored best val_acc={best_val:.1%}")
    head.eval()


def select_logits(logits: torch.Tensor, class_indices: list[int] | None) -> torch.Tensor:
    if class_indices is None:
        return logits
    return logits[:, class_indices]


def parse_split(raw: str) -> tuple[int, int, int]:
    parts = tuple(int(item.strip()) for item in raw.split(",") if item.strip())
    if len(parts) != 3 or any(part < 0 for part in parts) or sum(parts) <= 0:
        raise SystemExit("--split must be three non-negative integers, e.g. 8,1,1")
    return parts  # type: ignore[return-value]


def stratified_split_indices(
    labels: torch.Tensor,
    parts: tuple[int, int, int],
    *,
    seed: int,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    y = labels.detach().cpu().tolist()
    by_class: dict[int, list[int]] = {}
    for index, label in enumerate(y):
        by_class.setdefault(int(label), []).append(index)
    train: list[int] = []
    val: list[int] = []
    test: list[int] = []
    total = sum(parts)
    for cls, indices in sorted(by_class.items()):
        rng = torch.Generator().manual_seed(seed + cls * 1009)
        order = torch.randperm(len(indices), generator=rng).tolist()
        shuffled = [indices[i] for i in order]
        n = len(shuffled)
        n_train = n * parts[0] // total
        n_val = n * parts[1] // total
        n_test = n - n_train - n_val
        train.extend(shuffled[:n_train])
        val.extend(shuffled[n_train : n_train + n_val])
        test.extend(shuffled[n_train + n_val :])
        print(f"[fit-smr] split class={cls} n={n} train={n_train} val={n_val} test={n_test}")
    device = labels.device
    return (
        torch.tensor(train, device=device, dtype=torch.long),
        torch.tensor(val, device=device, dtype=torch.long),
        torch.tensor(test, device=device, dtype=torch.long),
    )


def classification_report(
    name: str,
    logits: torch.Tensor,
    labels: torch.Tensor,
    class_names: tuple[str, ...],
) -> None:
    pred = logits.argmax(dim=1)
    acc = float((pred == labels).float().mean())
    recalls: list[float] = []
    n_class = len(class_names)
    print(f"[fit-smr] {name} acc={acc:.1%}")
    for index, class_name in enumerate(class_names):
        mask = labels == index
        count = int(mask.sum())
        recall = float((pred[mask] == index).float().mean()) if count else float("nan")
        recalls.append(recall)
        print(f"[fit-smr]   {class_name}: n={count} recall={recall:.1%}" if count else f"[fit-smr]   {class_name}: n=0")
    finite = [value for value in recalls if value == value]
    if finite:
        print(f"[fit-smr] {name} balanced_acc={sum(finite) / len(finite):.1%}")
    confusion = torch.zeros((n_class, n_class), dtype=torch.int64)
    for true_i, pred_i in zip(labels.tolist(), pred.tolist()):
        confusion[int(true_i), int(pred_i)] += 1
    header = "true\\pred " + " ".join(f"{name:>10}" for name in class_names)
    print(f"[fit-smr] {name} confusion")
    print(header)
    for row_i, class_name in enumerate(class_names):
        cells = " ".join(f"{int(confusion[row_i, col_i]):>10}" for col_i in range(n_class))
        print(f"{class_name:>9} {cells}")


def clone_linear(head: nn.Linear) -> nn.Linear:
    copy = nn.Linear(head.in_features, head.out_features, device=head.weight.device, dtype=head.weight.dtype)
    copy.load_state_dict(head.state_dict())
    return copy


def load_init_state(backend: ReveModelBackend, path: Path) -> None:
    if backend._head is None:
        raise SystemExit("head is not loaded")
    payload = torch.load(path, map_location=backend._head.weight.device, weights_only=False)
    if not isinstance(payload, dict) or "head" not in payload:
        raise SystemExit(f"--init-state missing head weights: {path}")
    if payload.get("class_names") != list(backend.class_names):
        raise ValueError("SMR init-state class_names mismatch; legacy both-hand heads cannot initialize a tongue head")
    backend._head.load_state_dict(payload["head"])
    backend._update_step = int(payload.get("step", 0))
    print(
        f"[fit-smr] init-state loaded encoder={payload.get('encoder_id')} "
        f"task={payload.get('task')} step={backend._update_step} {path}"
    )


def save_state(path: Path, backend: ReveModelBackend) -> None:
    if backend._head is None:
        raise SystemExit("head is not loaded")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "head": backend._head.state_dict(),
        "step": backend._update_step,
        "model_revision": backend.model_revision,
        "task": backend.task,
        "class_names": list(backend.class_names),
        "encoder_id": backend.encoder_id,
    }
    buffer = BytesIO()
    torch.save(payload, buffer)
    path.write_bytes(buffer.getvalue())


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fit a frozen-REVE smr_control head from Passive-BCI smr-adapt bins (non-overlapping 2s windows)."
    )
    parser.add_argument("--recordings", type=Path, default=default_recordings_root())
    parser.add_argument("--session", action="append", default=[], help="Recording folder name or path. Repeatable.")
    parser.add_argument("--state-file", type=Path, default=None)
    parser.add_argument(
        "--init-state",
        type=Path,
        default=None,
        help="Warm-start the linear head from an existing .pt; skips random re-init.",
    )
    parser.add_argument("--size", choices=("base", "large"), default="base")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--epochs", type=int, default=400)
    parser.add_argument("--lr", type=float, default=0.02)
    parser.add_argument(
        "--checkpoint-root",
        type=Path,
        default=default_checkpoint_root(),
        help="Directory containing reve-base / reve-large / reve-positions.",
    )
    parser.add_argument(
        "--lora-checkpoint",
        type=Path,
        default=None,
        help="Optional PEFT LoRA training checkpoint merged into frozen REVE before encoding.",
    )
    parser.add_argument(
        "--no-lora",
        action="store_true",
        help="Fit on vanilla REVE instead of the Stieger SMR LoRA encoder.",
    )
    parser.add_argument(
        "--classes",
        default=None,
        help="Comma-separated class names to keep, e.g. left_hand,right_hand. Argmax is only among these.",
    )
    parser.add_argument(
        "--split",
        default=None,
        help="Stratified train,val,test ratios, e.g. 8,1,1. Skips session holdout.",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--hop-sec",
        type=float,
        default=None,
        help="Offline slice hop. Default equals the 2s window (non-overlapping). Do not use live 0.1s.",
    )
    parser.add_argument(
        "--label-source",
        choices=("auto", "trial"),
        default="auto",
        help="trial = tile 2s windows across feedbackSec (default 6s). auto prefers smr_window/foundation_label.",
    )
    args = parser.parse_args()

    recordings_root = args.recordings.resolve()
    if args.session:
        sessions = []
        for item in args.session:
            path = Path(item)
            sessions.append(path if path.is_dir() else recordings_root / item)
    else:
        sessions = discover_smr_recordings(recordings_root)
    windows = extract_all_labeled_windows(
        sessions,
        hop_sec=args.hop_sec,
        label_source=args.label_source,
    )
    class_indices: list[int] | None = None
    report_names: tuple[str, ...] = SMR_CONTROL_CLASS_NAMES
    if args.classes:
        wanted = tuple(name.strip() for name in args.classes.split(",") if name.strip())
        unknown = [name for name in wanted if name not in SMR_CONTROL_CLASS_NAMES]
        if unknown:
            raise SystemExit(f"Unknown classes {unknown}; expected {list(SMR_CONTROL_CLASS_NAMES)}")
        class_indices = [SMR_CONTROL_CLASS_NAMES.index(name) for name in wanted]
        report_names = wanted
        windows = [item for item in windows if item.class_name in wanted]
    if not windows:
        raise SystemExit(f"No labeled SMR trials in {recordings_root}")

    counts = Counter(item.class_name for item in windows)
    print(
        f"[fit-smr] sessions={len(sessions)} windows={len(windows)} "
        f"labels={dict(counts)} padded={sum(1 for item in windows if item.padded)}"
        + (f" restrict={list(report_names)}" if class_indices is not None else "")
    )

    root = args.checkpoint_root.resolve()
    model_dir = root / f"reve-{args.size}"
    positions_dir = root / "reve-positions"
    if not (model_dir / "model.safetensors").is_file():
        raise SystemExit(f"Missing REVE weights: {model_dir / 'model.safetensors'}")
    if not (positions_dir / "model.safetensors").is_file():
        raise SystemExit(f"Missing REVE positions: {positions_dir}")

    lora_checkpoint = args.lora_checkpoint
    if lora_checkpoint is None and not args.no_lora:
        lora_checkpoint = default_stieger_lora_checkpoint()
    encoder_id = lora_checkpoint.parent.name if lora_checkpoint is not None else f"reve-{args.size}"
    state_file = (args.state_file or default_state_file(recordings_root, encoder_id)).resolve()
    backend = ReveModelBackend(
        model_dir=model_dir,
        positions_dir=positions_dir,
        device=args.device,
        strategy="supervised-head",
        task="smr_control",
        lr=args.lr,
        state_file=None,
        cache_size=max(128, len(windows) + 8),
        lora_checkpoint=lora_checkpoint,
    )
    backend.load()
    if backend._head is None:
        raise SystemExit("REVE head is not loaded")
    reset_head = args.init_state is None
    if args.init_state is not None:
        init_path = args.init_state.resolve()
        if not init_path.is_file():
            raise SystemExit(f"Missing --init-state: {init_path}")
        if init_path == state_file:
            raise SystemExit("--init-state and --state-file must be different paths")
        load_init_state(backend, init_path)

    features, labels = encode_windows(backend, windows)
    if class_indices is not None:
        remap = {old: new for new, old in enumerate(class_indices)}
        labels = torch.tensor([remap[int(value)] for value in labels.tolist()], device=labels.device, dtype=torch.long)
    backend._head.eval()
    with torch.no_grad():
        zero_shot = select_logits(backend._head(features), class_indices)
    classification_report("zero-shot", zero_shot, labels, report_names)
    today_mask = torch.tensor(["0824" in item.session_id for item in windows], device=features.device)
    if bool(today_mask.any()):
        classification_report("zero-shot today", zero_shot[today_mask], labels[today_mask], report_names)
    if bool((~today_mask).any()) and bool(today_mask.any()):
        classification_report("zero-shot historical", zero_shot[~today_mask], labels[~today_mask], report_names)

    split_parts = parse_split(args.split) if args.split else None
    if split_parts is not None:
        train_idx, val_idx, test_idx = stratified_split_indices(labels, split_parts, seed=args.seed)
        print(
            f"[fit-smr] split {split_parts[0]}:{split_parts[1]}:{split_parts[2]} "
            f"n={len(labels)} train={len(train_idx)} val={len(val_idx)} test={len(test_idx)} seed={args.seed}"
        )
        with torch.no_grad():
            classification_report("zero-shot test", zero_shot[test_idx], labels[test_idx], report_names)
        train_linear_head(
            backend._head,
            features[train_idx],
            labels[train_idx],
            epochs=args.epochs,
            lr=args.lr,
            class_indices=class_indices,
            val_features=features[val_idx] if len(val_idx) else None,
            val_labels=labels[val_idx] if len(val_idx) else None,
            reset=reset_head,
        )
        backend._head.eval()
        with torch.no_grad():
            logits = select_logits(backend._head(features), class_indices)
        classification_report("train", logits[train_idx], labels[train_idx], report_names)
        if len(val_idx):
            classification_report("val", logits[val_idx], labels[val_idx], report_names)
        if len(test_idx):
            classification_report("test", logits[test_idx], labels[test_idx], report_names)
        if bool(today_mask.any()):
            classification_report("joint today", logits[today_mask], labels[today_mask], report_names)
    else:
        session_ids = [item.session_id for item in windows]
        unique_sessions = list(dict.fromkeys(session_ids))
        if len(unique_sessions) >= 2:
            for held in unique_sessions:
                train_mask = torch.tensor([sid != held for sid in session_ids], device=features.device)
                test_mask = ~train_mask
                if int(train_mask.sum()) == 0 or int(test_mask.sum()) == 0:
                    continue
                probe = clone_linear(backend._head)
                train_linear_head(
                    probe,
                    features[train_mask],
                    labels[train_mask],
                    epochs=args.epochs,
                    lr=args.lr,
                    class_indices=class_indices,
                    reset=reset_head,
                )
                probe.eval()
                with torch.no_grad():
                    holdout = select_logits(probe(features[test_mask]), class_indices)
                classification_report(
                    f"holdout {held} (train n={int(train_mask.sum())} test n={int(test_mask.sum())})",
                    holdout,
                    labels[test_mask],
                    report_names,
                )

        train_linear_head(
            backend._head,
            features,
            labels,
            epochs=args.epochs,
            lr=args.lr,
            class_indices=class_indices,
            reset=reset_head,
        )
        backend._head.eval()
        with torch.no_grad():
            fitted = select_logits(backend._head(features), class_indices)
        classification_report("train (all windows)", fitted, labels, report_names)

    backend._update_step = args.epochs
    backend.model_revision = f"{backend.encoder_id}-smr-fit-{len(windows)}"
    save_state(state_file, backend)
    print(f"[fit-smr] saved {state_file}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
