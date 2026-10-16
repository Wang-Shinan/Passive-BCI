from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import torch
from torch import nn

PEFT_BACKBONE_PREFIX = "encoder.backbone.base_model.model."
S02_0825PM_JOINT_LORA_ID = "smr_control_s02_4class_reve_0825pm_joint_livehead_lora"
S02_0825PM_HOP01_LORA_ID = "smr_control_s02_4class_reve_0825pm_hop01_lp_lora"
S02_0821_LIVEHEAD_LORA_ID = "smr_control_s02_4class_reve_0821_livehead_lora"
S02_LIVEHEAD_LORA_ID = "smr_control_s02_4class_reve_livehead_lora"
S01_LIVEHEAD_LORA_ID = "smr_control_s01_4class_reve_livehead_lora"
STIEGER_4CLASS_LORA_ID = "stieger2021_4class_reve_lora_r16_mi5init"
STIEGER_LR_LORA_ID = "stieger2021_lr_reve_lora_r16_mi5init"


def default_adapter_root() -> Path:
    from bci_dayloop.serving.embed_paths import adapter_root
    return adapter_root()


def default_stieger_lora_checkpoint() -> Path | None:
    s02_joint = default_adapter_root() / S02_0825PM_JOINT_LORA_ID / "best.pt"
    if s02_joint.is_file():
        return s02_joint
    s02_0825pm = default_adapter_root() / S02_0825PM_HOP01_LORA_ID / "best.pt"
    if s02_0825pm.is_file():
        return s02_0825pm
    s02_0821 = default_adapter_root() / S02_0821_LIVEHEAD_LORA_ID / "best.pt"
    if s02_0821.is_file():
        return s02_0821
    s02 = default_adapter_root() / S02_LIVEHEAD_LORA_ID / "best.pt"
    if s02.is_file():
        return s02
    four = default_adapter_root() / STIEGER_4CLASS_LORA_ID / "best.pt"
    if four.is_file():
        return four
    two = default_adapter_root() / STIEGER_LR_LORA_ID / "best.pt"
    return two if two.is_file() else None


def encoder_id_for_lora(path: Path | None, fallback: str) -> str:
    if path is None:
        return fallback
    return path.parent.name or fallback


def lora_state_stem(encoder_id: str) -> str:
    if encoder_id == S02_0825PM_JOINT_LORA_ID:
        return "smr_control_s02_0825pm_joint_4class_livehead"
    if encoder_id == S02_0825PM_HOP01_LORA_ID:
        return "smr_control_s02_0825pm_4class_livehead"
    if encoder_id in {S02_0821_LIVEHEAD_LORA_ID, S02_LIVEHEAD_LORA_ID}:
        return "smr_control_s02_4class_livehead"
    if encoder_id == S01_LIVEHEAD_LORA_ID:
        return "smr_control_s01_4class_livehead"
    if encoder_id == STIEGER_4CLASS_LORA_ID:
        return "smr_control_stieger_4class_lora"
    if encoder_id == STIEGER_LR_LORA_ID:
        return "smr_control_stieger_lora"
    if encoder_id in {"reve-base", "reve-large", "base"}:
        return "smr_control"
    return f"smr_control_{encoder_id}"


# Historical Stieger checkpoints without metadata used both hands, never tongue.
SMR_4CLASS_LABELS = ("left_hand", "right_hand", "both_hand", "rest")


def _labels_from_train_report(path: Path) -> tuple[str, ...]:
    report = path.parent / "train-report.json"
    if not report.is_file():
        return ()
    try:
        data = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ()
    task = data.get("task") if isinstance(data, dict) else None
    names = task.get("label_names") if isinstance(task, dict) else None
    if not isinstance(names, list):
        return ()
    return tuple(str(name) for name in names)


def hf_module_key(checkpoint_key: str) -> str | None:
    if checkpoint_key == "encoder.pos" or checkpoint_key.startswith("head."):
        return None
    if ".lora_A." in checkpoint_key or ".lora_B." in checkpoint_key:
        return None
    if not checkpoint_key.startswith(PEFT_BACKBONE_PREFIX):
        return None
    key = checkpoint_key[len(PEFT_BACKBONE_PREFIX) :]
    return key.replace(".base_layer.weight", ".weight").replace(".base_layer.bias", ".bias")


def merge_peft_lora_state_dict(
    state_dict: Mapping[str, torch.Tensor],
    *,
    rank: int,
    alpha: float,
) -> dict[str, torch.Tensor]:
    if rank <= 0:
        raise ValueError("LoRA rank must be > 0")
    scale = float(alpha) / float(rank)
    merged: dict[str, torch.Tensor] = {}
    for key, tensor in state_dict.items():
        hf_key = hf_module_key(key)
        if hf_key is None or not torch.is_tensor(tensor):
            continue
        merged[hf_key] = tensor.detach().clone()

    applied = 0
    for key, lora_a in state_dict.items():
        if ".lora_A.default.weight" not in key or not torch.is_tensor(lora_a):
            continue
        lora_b_key = key.replace(".lora_A.default.weight", ".lora_B.default.weight")
        base_key = key.replace(".lora_A.default.weight", ".base_layer.weight")
        hf_key = hf_module_key(base_key)
        lora_b = state_dict.get(lora_b_key)
        if hf_key is None or hf_key not in merged or not torch.is_tensor(lora_b):
            raise KeyError(f"LoRA pair is incomplete for {key}")
        delta = scale * (lora_b @ lora_a)
        if merged[hf_key].shape != delta.shape:
            raise ValueError(
                f"LoRA delta shape {tuple(delta.shape)} does not match {hf_key} {tuple(merged[hf_key].shape)}"
            )
        merged[hf_key] = merged[hf_key] + delta.to(dtype=merged[hf_key].dtype)
        applied += 1
    if applied == 0:
        raise ValueError("checkpoint has no PEFT LoRA weights to merge")
    return merged


def apply_merged_state_dict(model: nn.Module, merged: Mapping[str, torch.Tensor]) -> dict[str, int]:
    current = model.state_dict()
    mapped: dict[str, torch.Tensor] = {}
    skipped_unknown = 0
    for key, tensor in merged.items():
        if key not in current:
            skipped_unknown += 1
            continue
        if tuple(current[key].shape) != tuple(tensor.shape):
            raise ValueError(
                f"shape mismatch for {key}: checkpoint {tuple(tensor.shape)} vs model {tuple(current[key].shape)}"
            )
        mapped[key] = tensor.to(device=current[key].device, dtype=current[key].dtype)
    incompatible, unexpected = model.load_state_dict(mapped, strict=False)
    return {
        "loaded": len(mapped),
        "missing": len(incompatible),
        "unexpected": len(unexpected),
        "skipped_unknown": skipped_unknown,
    }


def seed_linear_head_from_labels(
    head: nn.Linear,
    weight: torch.Tensor,
    bias: torch.Tensor,
    *,
    source_names: Sequence[str],
    dest_names: Sequence[str],
) -> int:
    if weight.ndim != 2 or bias.ndim != 1:
        raise ValueError("pretrained head must be a linear weight [K, D] and bias [K]")
    if weight.shape[0] != len(source_names) or bias.shape[0] != len(source_names):
        raise ValueError("pretrained head size does not match source class names")
    if head.weight.shape[1] != weight.shape[1]:
        raise ValueError(
            f"embed dim mismatch: head {head.weight.shape[1]} vs pretrained {weight.shape[1]}"
        )
    copied = 0
    source_index = {str(name): index for index, name in enumerate(source_names)}
    with torch.no_grad():
        for dest_i, name in enumerate(dest_names):
            src_i = source_index.get(str(name))
            if src_i is None:
                continue
            head.weight[dest_i].copy_(weight[src_i].to(device=head.weight.device, dtype=head.weight.dtype))
            head.bias[dest_i].copy_(bias[src_i].to(device=head.bias.device, dtype=head.bias.dtype))
            copied += 1
    return copied


@dataclass(frozen=True, slots=True)
class ReveLoraPayload:
    state_dict: dict[str, torch.Tensor]
    meta: dict[str, Any]
    rank: int
    alpha: float
    label_names: tuple[str, ...]
    head_weight: torch.Tensor | None
    head_bias: torch.Tensor | None
    encoder_id: str


def load_reve_lora_payload(path: Path) -> ReveLoraPayload:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict) or "model" not in payload:
        raise ValueError(f"{path} is not a REVE LoRA training checkpoint")
    state = payload["model"]
    if not isinstance(state, dict):
        raise ValueError(f"{path} model state is not a dict")
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    lora_meta = meta.get("lora") if isinstance(meta.get("lora"), dict) else {}
    rank = int(lora_meta.get("rank", 16))
    alpha = float(lora_meta.get("alpha", 32))
    labels = tuple(str(name) for name in meta.get("label_names", ()))
    if not labels:
        labels = _labels_from_train_report(path)
    head_weight = state.get("head.fc.weight")
    head_bias = state.get("head.fc.bias")
    if not torch.is_tensor(head_weight):
        head_weight = None
    if not torch.is_tensor(head_bias):
        head_bias = None
    if (
        not labels
        and head_weight is not None
        and int(head_weight.shape[0]) == len(SMR_4CLASS_LABELS)
    ):
        labels = SMR_4CLASS_LABELS
    return ReveLoraPayload(
        state_dict={key: value for key, value in state.items() if torch.is_tensor(value)},
        meta=meta,
        rank=rank,
        alpha=alpha,
        label_names=labels,
        head_weight=head_weight,
        head_bias=head_bias,
        encoder_id=encoder_id_for_lora(path, STIEGER_LR_LORA_ID),
    )
