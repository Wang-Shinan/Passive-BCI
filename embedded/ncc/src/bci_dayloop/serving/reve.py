from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
import time
from typing import Any, Sequence

import numpy as np
import torch
from torch import nn
import torch.nn.functional as F

from bci_dayloop.serving.profiles import (
    REVE_STEP_SEC,
    REVE_TARGET_HZ,
    REVE_WINDOW_SEC,
    TETRIS_LIVE_STEP_SEC,
)
from bci_dayloop.serving.protocol import (
    ParsedFeedback,
    ParsedWindow,
    PredictionResult,
    ProtocolError,
    feedback_ack_message,
    hello_message,
    new_observation_id,
    validate_electrode_positions,
)
from bci_dayloop.serving.reve_lora import (
    apply_merged_state_dict,
    encoder_id_for_lora,
    load_reve_lora_payload,
    merge_peft_lora_state_dict,
    seed_linear_head_from_labels,
)

ORDINAL_CLASS_NAMES: tuple[str, ...] = ("任务一", "任务二", "任务三")
TETRIS_ACTION_CLASS_NAMES: tuple[str, ...] = (
    "rest",
    "left",
    "right",
    "rotateCW",
    "rotateCCW",
    "softDrop",
    "hardDrop",
)
SMR_CONTROL_CLASS_NAMES: tuple[str, ...] = (
    "left_hand",
    "right_hand",
    "tongue",
    "rest",
)
CHANNEL_ALIASES: dict[str, str] = {
    "t3": "t7",
    "t4": "t8",
    "t5": "p7",
    "t6": "p8",
}


@dataclass(frozen=True, slots=True)
class ReveTaskSpec:
    id: str
    class_names: tuple[str, ...]
    output_semantics: str
    hello_task: str
    live_step_sec: float = REVE_STEP_SEC


REVE_TASKS: dict[str, ReveTaskSpec] = {
    "gaze_smr": ReveTaskSpec(
        id="gaze_smr", class_names=("left", "right", "up", "down"),
        output_semantics="gaze_smr_direction_4", hello_task="gaze_smr",
    ),
    "passive_rating": ReveTaskSpec(
        id="passive_rating",
        class_names=ORDINAL_CLASS_NAMES,
        output_semantics="ordinal_rating_3",
        hello_task="passive_rating",
    ),
    "tetris_action": ReveTaskSpec(
        id="tetris_action",
        class_names=TETRIS_ACTION_CLASS_NAMES,
        output_semantics="tetris_action_7",
        hello_task="tetris_action",
        live_step_sec=TETRIS_LIVE_STEP_SEC,
    ),
    "smr_control": ReveTaskSpec(
        id="smr_control",
        class_names=SMR_CONTROL_CLASS_NAMES,
        output_semantics="smr_control_4",
        hello_task="smr_control",
    ),
}


def normalize_reve_task(value: str) -> str:
    key = value.strip().lower().replace("-", "_")
    aliases = {
        "gaze_smr": "gaze_smr",
        "rating": "passive_rating",
        "ordinal": "passive_rating",
        "passive_rating": "passive_rating",
        "tetris": "tetris_action",
        "action": "tetris_action",
        "tetris_action": "tetris_action",
        "smr": "smr_control",
        "smr_control": "smr_control",
        "smr_cursor": "smr_control",
        "cursor": "smr_control",
    }
    try:
        return aliases[key]
    except KeyError as error:
        known = ", ".join(sorted(REVE_TASKS))
        raise ValueError(f"Unknown REVE task {value!r}. Known: {known}") from error


def get_reve_task(task: str) -> ReveTaskSpec:
    return REVE_TASKS[normalize_reve_task(task)]


def live_step_sec_for_task(task: str) -> float:
    """Hello hop for live decode. Offline export/fit must use hop=window, not this value."""
    return get_reve_task(task).live_step_sec


def default_serve_strategy(task: str) -> str:
    """Live SMR is frozen; other REVE heads still accept supervised-head SGD."""
    if normalize_reve_task(task) in ("smr_control", "gaze_smr"):
        return "none"
    return "supervised-head"


def default_checkpoint_root() -> Path:
    from bci_dayloop.serving.embed_paths import checkpoint_root
    return checkpoint_root()


def _compat_patch_reve_modeling(model_dir: Path) -> None:
    """REVE upstream assumes torch>=2.2 SDPA; NCC env is still 2.0.1."""
    from packaging.version import Version
    if Version(torch.__version__.split('+')[0]) >= Version('2.2'):
        return  # Preserve downloaded upstream code and its provenance on modern torch.
    path = model_dir / "modeling_reve.py"
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    if "Passive-BCI torch<2.2 fallback" in text:
        return
    if "from torch.nn.attention import SDPBackend, sdpa_kernel" not in text:
        return
    text = text.replace(
        "from torch.nn.attention import SDPBackend, sdpa_kernel",
        """try:
    from torch.nn.attention import SDPBackend, sdpa_kernel
except ImportError:  # Passive-BCI torch<2.2 fallback
    from contextlib import nullcontext

    class SDPBackend:
        FLASH_ATTENTION = "flash_attention"
        EFFICIENT_ATTENTION = "efficient_attention"
        MATH = "math"

    def sdpa_kernel(_backends):
        return nullcontext()
""",
    )
    text = text.replace(
        """        if self.use_sdpa:
            assert version.parse(torch.__version__) >= version.parse("2.2.0"), (
                "in order to use sdpa, you must be using pytorch 2.2 or above"
            )""",
        """        if self.use_sdpa and version.parse(torch.__version__) < version.parse("2.2.0"):
            self.use_sdpa = False  # Passive-BCI torch<2.2 fallback""",
    )
    path.write_text(text, encoding="utf-8")


def build_position_lookup(names: Sequence[str]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for name in names:
        key = str(name).strip().lower()
        if key:
            lookup.setdefault(key, str(name))
    return lookup


def resolve_channel_name(name: str, lookup: dict[str, str]) -> str | None:
    key = name.strip().lower()
    if key in lookup:
        return lookup[key]
    alias = CHANNEL_ALIASES.get(key)
    if alias and alias in lookup:
        return lookup[alias]
    return None


def select_supported_channels(
    data: np.ndarray,
    channel_names: Sequence[str],
    lookup: dict[str, str],
) -> tuple[np.ndarray, tuple[str, ...]]:
    if data.ndim != 2:
        raise ValueError(f"EEG window must be [C, T], got {data.shape}")
    if data.shape[0] != len(channel_names):
        raise ValueError("channel count does not match channel_names")
    kept: list[int] = []
    names: list[str] = []
    for index, name in enumerate(channel_names):
        resolved = resolve_channel_name(str(name), lookup)
        if resolved is None:
            continue
        kept.append(index)
        names.append(resolved)
    if len(kept) < 4:
        raise ValueError(
            f"REVE needs at least 4 mapped EEG channels, got {len(kept)}"
        )
    return data[np.asarray(kept, dtype=np.int64)], tuple(names)


def resample_to_length(data: np.ndarray, dst_samples: int) -> np.ndarray:
    if dst_samples <= 1:
        raise ValueError("dst_samples must be > 1")
    if data.shape[1] == dst_samples:
        return np.asarray(data, dtype=np.float32)
    src = np.linspace(0.0, 1.0, data.shape[1], dtype=np.float64)
    dst = np.linspace(0.0, 1.0, dst_samples, dtype=np.float64)
    out = np.empty((data.shape[0], dst_samples), dtype=np.float32)
    for channel in range(data.shape[0]):
        out[channel] = np.interp(dst, src, data[channel]).astype(np.float32, copy=False)
    return out


def zscore_channels(data: np.ndarray) -> np.ndarray:
    mean = data.mean(axis=1, keepdims=True)
    std = data.std(axis=1, keepdims=True)
    std = np.maximum(std, 1e-6)
    return ((data - mean) / std).astype(np.float32, copy=False)


def window_duration_sec(window: ParsedWindow) -> float:
    if window.start_time_sec is not None and window.end_time_sec is not None:
        return float(window.end_time_sec - window.start_time_sec)
    return float(window.samples) / float(window.sample_rate)


def prepare_reve_window(
    data: np.ndarray,
    channel_names: Sequence[str],
    sample_rate: float,
    lookup: dict[str, str],
    *,
    window_sec: float = REVE_WINDOW_SEC,
    target_hz: float = REVE_TARGET_HZ,
    electrode_positions: Sequence[Sequence[float]] | None = None,
    require_all_channels: bool = False,
) -> tuple[np.ndarray, tuple[str, ...]]:
    if electrode_positions is not None:
        if data.ndim != 2 or data.shape[0] != len(channel_names) or len(channel_names) < 4:
            raise ValueError("REVE needs at least 4 EEG channels with matching coordinates")
        validate_electrode_positions(electrode_positions, len(channel_names))
        selected, names = data, tuple(channel_names)
    else:
        selected, names = select_supported_channels(data, channel_names, lookup)
        if require_all_channels and (len(names) != len(channel_names) or len(set(names)) != len(names)):
            raise ValueError("Every explicit electrode name must map to a distinct REVE position")
    dst_samples = int(round(window_sec * target_hz))
    if abs(sample_rate - target_hz) > 1e-6 or selected.shape[1] != dst_samples:
        selected = resample_to_length(selected, dst_samples)
    return zscore_channels(selected), names


def _softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    scale = max(float(temperature), 1e-6)
    shifted = (logits / scale) - np.max(logits / scale)
    exp = np.exp(shifted)
    return exp / np.sum(exp)


def l2_normalize_features(features: torch.Tensor) -> torch.Tensor:
    return F.normalize(features, p=2, dim=-1)


def init_linear_head(head: nn.Linear) -> None:
    """Zero weights so an untrained head is uniform, not a saturated one-hot."""
    nn.init.zeros_(head.weight)
    nn.init.zeros_(head.bias)


@dataclass(slots=True)
class ReveModelBackend:
    model_dir: Path
    positions_dir: Path
    device: str = "auto"
    window_sec: float = REVE_WINDOW_SEC
    step_sec: float | None = None
    target_hz: float = REVE_TARGET_HZ
    class_names: tuple[str, ...] = ORDINAL_CLASS_NAMES
    task: str = "passive_rating"
    model_revision: str = "base"
    strategy: str = "supervised-head"
    lr: float = 0.05
    state_file: Path | None = None
    cache_size: int = 128
    replay_per_class: int = 24
    replay_steps: int = 12
    replay_balanced: int = 8
    lora_checkpoint: Path | None = None
    feature_normalization: str = 'l2'
    input_clip: float | None = None
    preprocessing_profile: str | None = None
    input_channel_names: tuple[str, ...] = ()
    _model: Any = field(default=None, init=False, repr=False)
    _pos_bank: Any = field(default=None, init=False, repr=False)
    _head: nn.Linear | None = field(default=None, init=False, repr=False)
    _lookup: dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _torch_device: torch.device | None = field(default=None, init=False, repr=False)
    _cache: OrderedDict[str, torch.Tensor] = field(default_factory=OrderedDict, init=False, repr=False)
    _replay: list[list[torch.Tensor]] = field(default_factory=list, init=False, repr=False)
    _update_step: int = field(default=0, init=False, repr=False)
    _head_source: str = field(default='untrained', init=False, repr=False)
    head_initialization: dict[str, Any] | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        spec = get_reve_task(self.task)
        self.task = spec.id
        self.class_names = spec.class_names
        self._replay = [[] for _ in spec.class_names]
        resolved_step = spec.live_step_sec if self.step_sec is None else float(self.step_sec)
        if not (resolved_step > 0) or resolved_step > float(self.window_sec):
            raise ValueError(
                f"live step_sec must satisfy 0 < step_sec <= window_sec, got {resolved_step}"
            )
        self.step_sec = resolved_step
        if self.lora_checkpoint is not None:
            self.lora_checkpoint = Path(self.lora_checkpoint)

    @property
    def task_spec(self) -> ReveTaskSpec:
        return get_reve_task(self.task)

    @property
    def encoder_id(self) -> str:
        return encoder_id_for_lora(self.lora_checkpoint, self.model_dir.name)

    def load(self) -> None:
        try:
            from transformers import AutoModel
        except ImportError as error:
            raise SystemExit(
                "REVE serving needs transformers, einops, and safetensors. "
                "Install with: pip install transformers einops safetensors"
            ) from error

        resolved = self.device
        if resolved == "auto":
            resolved = "cuda" if torch.cuda.is_available() else "cpu"
        self._torch_device = torch.device(resolved)
        _compat_patch_reve_modeling(self.model_dir)
        self._pos_bank = AutoModel.from_pretrained(
            str(self.positions_dir),
            trust_remote_code=True,
            local_files_only=True,
        ).to(self._torch_device)
        self._pos_bank.eval()
        position_names = list(getattr(self._pos_bank, "position_names", []))
        if not position_names:
            config_names = getattr(self._pos_bank.config, "position_names", [])
            position_names = [str(name) for name in config_names]
        self._lookup = build_position_lookup(position_names)
        self._model = AutoModel.from_pretrained(
            str(self.model_dir),
            trust_remote_code=True,
            local_files_only=True,
        ).to(self._torch_device)
        self._model.eval()
        for parameter in self._model.parameters():
            parameter.requires_grad_(False)
        embed_dim = int(getattr(self._model.config, "embed_dim"))
        self._head = nn.Linear(embed_dim, len(self.class_names), device=self._torch_device)
        init_linear_head(self._head)
        self._apply_lora_checkpoint()
        self._head.eval()
        self.model_revision = self.encoder_id
        self._load_state_file()

    def _apply_lora_checkpoint(self) -> None:
        if self.lora_checkpoint is None or self._model is None or self._head is None:
            return
        if not self.lora_checkpoint.is_file():
            raise FileNotFoundError(f"REVE LoRA checkpoint not found: {self.lora_checkpoint}")
        payload = load_reve_lora_payload(self.lora_checkpoint)
        merged = merge_peft_lora_state_dict(payload.state_dict, rank=payload.rank, alpha=payload.alpha)
        stats = apply_merged_state_dict(self._model, merged)
        if payload.head_weight is not None and payload.head_bias is not None and payload.label_names:
            seeded = seed_linear_head_from_labels(
                self._head,
                payload.head_weight,
                payload.head_bias,
                source_names=payload.label_names,
                dest_names=self.class_names,
            )
        else:
            seeded = 0
        # A new subject starts from the entire pretrained head. This is transfer
        # initialization, not a claim that legacy both-hand data labels were tongue.
        legacy_names = ('left_hand', 'right_hand', 'both_hand', 'rest')
        legacy_transfer = self.task == 'smr_control' and payload.label_names == legacy_names and seeded == 3
        if legacy_transfer:
            with torch.no_grad():
                self._head.weight[2].copy_(payload.head_weight[2].to(self._head.weight))
                self._head.bias[2].copy_(payload.head_bias[2].to(self._head.bias))
            seeded += 1
        self.head_initialization = {
            'source': 'lora-checkpoint', 'encoder_id': payload.encoder_id,
            'source_class_names': list(payload.label_names), 'target_class_names': list(self.class_names),
            'legacy_transfer': legacy_transfer, 'copied_rows': seeded,
        }
        if seeded == len(self.class_names):
            self._head_source = 'lora-checkpoint'
        print(
            f"[reve] lora={payload.encoder_id} rank={payload.rank} alpha={payload.alpha:g} "
            f"loaded={stats['loaded']} missing={stats['missing']} seeded_head={seeded}"
        )

    @property
    def torch_device_name(self) -> str:
        return str(self._torch_device) if self._torch_device is not None else self.device

    def hello_payload(self) -> dict[str, Any]:
        spec = self.task_spec
        payload = hello_message(
            service="ncc-reve",
            model_name=self.model_dir.name,
            model_type="reve",
            task=spec.hello_task,
            class_names=spec.class_names,
            model_revision=self.model_revision,
            strategy=self.strategy,
            window_sec=self.window_sec,
            step_sec=float(self.step_sec),
        )
        if self._head_source == 'untrained' and self._update_step == 0:
            payload['warning'] = '分类头尚未训练：当前仅验证 REVE 推理链路，不能用于有效脑控。请先采集标签并训练。'
        if self.head_initialization:
            payload['head_initialization'] = self.head_initialization
            if self.head_initialization.get('legacy_transfer') and self._update_step == 0:
                payload['warning'] = '使用 LoRA 自带完整线性头初始化；第三行源于双手类别，尚未经过本被试舌头想象训练。'
        if self.preprocessing_profile:
            payload['input']['slide_sec'] = 0.1
            payload['supports_group_training'] = self.preprocessing_profile == 's04-mne-4s-v1' and self.window_sec in (2, 4)
            payload['preprocessing'] = {
                'profile': self.preprocessing_profile, 'feature_normalization': self.feature_normalization,
                'input_clip': self.input_clip, 'channel_names': list(self.input_channel_names),
                'target_hz': self.target_hz,
            }
        return payload

    def predict(self, window: ParsedWindow) -> PredictionResult:
        if self._model is None or self._pos_bank is None or self._head is None:
            raise ProtocolError("REVE backend is not loaded", code="internal_error")
        duration = window_duration_sec(window)
        if abs(duration - self.window_sec) > max(0.08, 0.08 * self.window_sec):
            raise ProtocolError(
                f"REVE expects {self.window_sec:g}s windows, got {duration:.3f}s",
                code="invalid_window",
                request_id=window.request_id,
            )
        started = time.perf_counter()
        try:
            if self.preprocessing_profile == 's04-mne-4s-v1':
                from bci_dayloop.serving.reve_s04 import prepare_s04_window
                prepared, names = prepare_s04_window(window.data, window.channel_names,
                    window.sample_rate, self.input_channel_names, window_sec=self.window_sec)
            else:
                prepared, names = prepare_reve_window(
                    window.data,
                    window.electrode_names if window.electrode_positions is None and window.electrode_names is not None else window.channel_names,
                    window.sample_rate,
                    self._lookup,
                    window_sec=self.window_sec,
                    target_hz=self.target_hz,
                    electrode_positions=window.electrode_positions,
                    require_all_channels=window.electrode_names is not None,
                )
        except ValueError as error:
            raise ProtocolError(
                str(error),
                code="invalid_window",
                request_id=window.request_id,
            ) from error
        if self.input_clip is not None:
            prepared = np.clip(prepared, -self.input_clip, self.input_clip)
        prepare_ms = (time.perf_counter() - started) * 1000.0

        inferred = time.perf_counter()
        eeg = torch.from_numpy(np.ascontiguousarray(prepared)).unsqueeze(0)
        eeg = eeg.to(self._torch_device, dtype=torch.float32)
        with torch.no_grad():
            positions = (
                torch.tensor(window.electrode_positions, dtype=torch.float32, device=self._torch_device)
                if window.electrode_positions is not None and self.preprocessing_profile is None
                else self._pos_bank(list(names)).to(self._torch_device)
            )
            if positions.ndim == 2:
                positions = positions.unsqueeze(0)
            tokens = self._model(eeg, positions)
            features = self._model.attention_pooling(tokens)
            if self.feature_normalization == 'l2':
                features = l2_normalize_features(features)
            observation_id = new_observation_id()
            self._remember(observation_id, features)
            logits = self._head(features).squeeze(0).detach().cpu().numpy()
        infer_ms = (time.perf_counter() - inferred) * 1000.0
        probabilities = _softmax(np.asarray(logits, dtype=np.float64).reshape(-1))
        class_id = int(np.argmax(probabilities))
        spec = self.task_spec
        return PredictionResult(
            request_id=window.request_id,
            observation_id=observation_id,
            window_id=window.window_id,
            segment_id=window.segment_id,
            class_id=class_id,
            class_name=spec.class_names[class_id],
            class_names=spec.class_names,
            probabilities=tuple(float(value) for value in probabilities),
            logits=tuple(float(value) for value in logits),
            confidence=float(probabilities[class_id]),
            model_revision=self.model_revision,
            online_update_step=self._update_step,
            online_update_applied=False,
            prepare_latency_ms=prepare_ms,
            inference_latency_ms=infer_ms,
            task=spec.hello_task,
            output_semantics=spec.output_semantics,
        )

    def ack_feedback(self, feedback: ParsedFeedback) -> dict[str, Any]:
        if self.strategy != "supervised-head":
            return feedback_ack_message(
                feedback,
                accepted=False,
                reason="online strategy is not enabled",
                model_revision=self.model_revision,
                online_update_step=self._update_step,
            )
        label = self._resolve_label(feedback)
        if label is None:
            return feedback_ack_message(
                feedback,
                accepted=False,
                reason=f"feedback requires a {len(self.class_names)}-class label",
                model_revision=self.model_revision,
                online_update_step=self._update_step,
            )
        features = self._cache.get(feedback.observation_id)
        if features is None or self._head is None or self._torch_device is None:
            return feedback_ack_message(
                feedback,
                accepted=False,
                reason="unknown observation_id" if features is None else "REVE head is not loaded",
                model_revision=self.model_revision,
                online_update_step=self._update_step,
            )
        applied = self._replay_step(features, label)
        return feedback_ack_message(
            feedback,
            accepted=applied,
            reason=None if applied else "online update failed",
            model_revision=self.model_revision,
            online_update_step=self._update_step,
            online_update_applied=applied,
        )

    def _remember(self, observation_id: str, features: torch.Tensor) -> None:
        self._cache[observation_id] = l2_normalize_features(features.detach()) if self.feature_normalization == 'l2' else features.detach()
        self._cache.move_to_end(observation_id)
        while len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)

    def _resolve_label(self, feedback: ParsedFeedback) -> int | None:
        if feedback.label is not None and 0 <= feedback.label < len(self.class_names):
            return int(feedback.label)
        if self.task != "passive_rating" or feedback.reward is None:
            return None
        if feedback.reward <= -0.25:
            return 0
        if feedback.reward >= 0.25:
            return 2
        return 1

    def _push_replay(self, features: torch.Tensor, label: int) -> None:
        bucket = self._replay[label]
        bucket.append(l2_normalize_features(features.detach()))
        overflow = len(bucket) - int(self.replay_per_class)
        if overflow > 0:
            del bucket[:overflow]

    def _balanced_replay_batch(self) -> tuple[torch.Tensor, torch.Tensor] | None:
        if self._torch_device is None:
            return None
        nonempty = [bucket for bucket in self._replay if bucket]
        if not nonempty:
            return None
        per_class = max(1, int(self.replay_balanced))
        features: list[torch.Tensor] = []
        labels: list[int] = []
        for class_id, bucket in enumerate(self._replay):
            if not bucket:
                continue
            for i in range(per_class):
                features.append(bucket[i % len(bucket)])
                labels.append(class_id)
        stacked = torch.cat(features, dim=0).to(self._torch_device)
        target = torch.tensor(labels, device=self._torch_device, dtype=torch.long)
        return stacked, target

    def _replay_step(self, features: torch.Tensor, label: int) -> bool:
        if self._head is None or self._torch_device is None:
            return False
        features = l2_normalize_features(features.to(self._torch_device))
        self._push_replay(features, label)
        batch = self._balanced_replay_batch()
        if batch is None:
            return False
        inputs, target = batch
        weights = None
        if self.task == "tetris_action":
            weights = torch.ones(len(self.class_names), device=self._torch_device)
            weights[0] = 0.25
        self._head.train()
        for _ in range(max(1, int(self.replay_steps))):
            self._head.zero_grad(set_to_none=True)
            logits = self._head(inputs)
            loss = F.cross_entropy(logits, target, weight=weights)
            if not torch.isfinite(loss):
                self._head.eval()
                return False
            loss.backward()
            torch.nn.utils.clip_grad_norm_(self._head.parameters(), 1.0)
            with torch.no_grad():
                for parameter in self._head.parameters():
                    if parameter.grad is None:
                        continue
                    parameter.add_(parameter.grad, alpha=-float(self.lr))
                self._clip_head_rows()
        self._head.eval()
        self._update_step += 1
        self.model_revision = f"{self.model_dir.name}-online-{self._update_step:06d}"
        self._save_state_file()
        return True

    def _clip_head_rows(self) -> None:
        if self._head is None:
            return
        max_norm = 4.0
        weight = self._head.weight
        norms = weight.norm(dim=1, keepdim=True).clamp_min(1e-6)
        weight.mul_(max_norm / norms.clamp_min(max_norm))

    def _load_state_file(self) -> None:
        if self.state_file is None or self._head is None or not self.state_file.is_file():
            return
        payload = torch.load(self.state_file, map_location=self._torch_device)
        saved_task = str(payload.get("task", "passive_rating"))
        if normalize_reve_task(saved_task) != self.task:
            return
        if self.task == 'smr_control' and payload.get('class_names') != list(self.class_names):
            raise ValueError('SMR head class_names mismatch: require left_hand/right_hand/tongue/rest; legacy both-hand heads must be retrained')
        saved_encoder = str(payload.get("encoder_id", self.model_dir.name))
        if saved_encoder != self.encoder_id:
            print(
                f"[reve] state-file skipped encoder mismatch "
                f"saved={saved_encoder} serving={self.encoder_id}"
            )
            return
        try:
            self._head.load_state_dict(payload["head"])
        except RuntimeError:
            return
        self._update_step = int(payload.get("step", 0))
        self.model_revision = str(payload.get("model_revision", self.model_revision))
        normalization = payload.get('feature_normalization', 'l2')
        if normalization not in ('none', 'l2'):
            raise ValueError('Unsupported head feature normalization')
        if normalization == 'none' and self.strategy != 'none':
            raise ValueError('Unnormalized imported heads require strategy=none')
        self.feature_normalization = normalization
        clip = payload.get('input_clip')
        if clip is not None and (not np.isfinite(float(clip)) or float(clip) <= 0):
            raise ValueError('Invalid input clip')
        self.input_clip = float(clip) if clip is not None else None
        profile = payload.get('preprocessing_profile')
        if profile not in (None, 's04-mne-4s-v1'):
            raise ValueError('Unsupported REVE preprocessing profile')
        self.preprocessing_profile = profile
        if profile == 's04-mne-4s-v1':
            names = payload.get('input_channel_names', [])
            if (self.task != 'smr_control' or self.strategy != 'none' or normalization != 'none'
                or self.input_clip != 15 or len(names) != 31 or len(set(names)) != 31
                or not all(isinstance(n, str) and n for n in names)):
                raise ValueError('Invalid S04 imported model input contract')
            self.input_channel_names = tuple(names)
            self.window_sec = float(payload.get('input_window_sec', 4))
            if self.window_sec not in (2, 4):
                raise ValueError('S04 input window must be 2 or 4 seconds')
            self.target_hz = 200.0
            if not 0 < float(self.step_sec) <= self.window_sec:
                raise ValueError('Invalid S04 prediction hop')
        self._head_source = 'state-file'
        self.head_initialization = payload.get('head_initialization')
        print(
            f"[reve] state-file loaded encoder={saved_encoder} "
            f"step={self._update_step} {self.state_file}"
        )
        saved_replay = payload.get("replay")
        if isinstance(saved_replay, list) and len(saved_replay) == len(self.class_names):
            restored: list[list[torch.Tensor]] = []
            for bucket in saved_replay:
                items = []
                if isinstance(bucket, list):
                    for item in bucket[-int(self.replay_per_class) :]:
                        if torch.is_tensor(item):
                            items.append(l2_normalize_features(item.to(self._torch_device)))
                restored.append(items)
            self._replay = restored

    def _save_state_file(self) -> None:
        if self.state_file is None or self._head is None:
            return
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "head": self._head.state_dict(),
            "step": self._update_step,
            "model_revision": self.model_revision,
            "task": self.task,
            "class_names": list(self.class_names),
            "head_initialization": self.head_initialization,
            "encoder_id": self.encoder_id,
            "lora_checkpoint": str(self.lora_checkpoint) if self.lora_checkpoint else None,
            "size": self.model_dir.name.removeprefix('reve-'),
            "feature_normalization": self.feature_normalization,
            "input_clip": self.input_clip,
            "preprocessing_profile": self.preprocessing_profile,
            "input_channel_names": list(self.input_channel_names),
            "input_window_sec": self.window_sec,
            "replay": [[item.detach().cpu() for item in bucket] for bucket in self._replay],
        }
        buffer = BytesIO()
        torch.save(payload, buffer)
        self.state_file.write_bytes(buffer.getvalue())
