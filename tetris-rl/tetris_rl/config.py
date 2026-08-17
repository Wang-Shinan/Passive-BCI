"""Train / eval configuration."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Literal

AlgoName = Literal["dqn", "ppo", "bc", "bc_ppo"]


@dataclass
class TrainConfig:
    algo: AlgoName = "dqn"
    seed: int = 7
    steps: int = 500_000
    num_envs: int = 8
    device: str = "auto"
    precision: str = "fp32"
    width: int = 64
    hidden: int = 512
    lr: float = 3e-4
    gamma: float = 0.99
    max_grad_norm: float = 10.0

    batch_size: int = 256
    buffer_size: int = 100_000
    train_interval: int = 4
    train_updates: int = 1
    target_sync: int = 2000
    n_step: int = 3
    double: bool = True
    dueling: bool = True
    imitate_frac: float = 0.4
    eps_start: float = 1.0
    eps_end: float = 0.05
    eps_decay: int = 200_000

    ppo_epochs: int = 4
    ppo_minibatch: int = 2048
    rollout_steps: int = 128
    gae_lambda: float = 0.95
    clip: float = 0.2
    entropy_coef: float = 0.02
    value_coef: float = 0.5
    reward_clip: float = 10.0

    bc_steps: int = 30_000
    bc_batch: int = 1024

    gravity_min: float = 1.0
    gravity_max: float = 6.0
    eval_every: int = 25_000
    eval_seeds: int = 16
    eval_max_steps: int = 800
    log_every: int = 5_000
    ckpt_every: int = 25_000
    compute_baselines: bool = True
    run_dir: str = "runs"
    run_name: str = ""
    resume: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TrainConfig:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in names})

    @classmethod
    def load(cls, path: Path) -> TrainConfig:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if "runs" in payload and isinstance(payload["runs"], list):
            raise ValueError(f"{path} looks like a sweep file; use --suite")
        return cls.from_dict(payload)


def resolve_device(name: str) -> str:
    import torch

    if name == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return name
