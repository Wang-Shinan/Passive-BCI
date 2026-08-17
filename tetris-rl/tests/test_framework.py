"""Smoke tests for the multi-algo training framework."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from tetris_rl.config import TrainConfig
from tetris_rl.export_onnx import build_export_model
from tetris_rl.run import train
from tetris_rl.vec_env import SyncVectorEnv


def _tiny(algo: str, tmp_path: Path) -> TrainConfig:
    return TrainConfig(
        algo=algo,  # type: ignore[arg-type]
        seed=0,
        steps=128,
        num_envs=2,
        device="cpu",
        precision="fp32",
        batch_size=16,
        buffer_size=256,
        n_step=1,
        train_interval=1,
        rollout_steps=16,
        ppo_epochs=1,
        ppo_minibatch=16,
        bc_batch=16,
        bc_steps=64,
        eval_every=128,
        eval_seeds=2,
        eval_max_steps=20,
        log_every=10_000,
        ckpt_every=10_000,
        compute_baselines=False,
        imitate_frac=0.0,
        run_dir=str(tmp_path),
        run_name=f"test_{algo}",
    )


def test_vec_env_shapes():
    env = SyncVectorEnv(3, seed=1)
    obs = env.reset(1)
    assert obs.shape == (3, 12, 20, 10)
    nxt, rew, done, info = env.step(np.zeros(3, dtype=np.int64), seed=1)
    assert nxt.shape == obs.shape
    assert rew.shape == (3,)
    assert done.shape == (3,)
    assert len(info) == 3


def test_train_dqn_smoke(tmp_path: Path):
    summary = train(_tiny("dqn", tmp_path))
    assert summary["env_steps"] >= 128
    ckpt = tmp_path / "test_dqn" / "ckpt" / "latest.pt"
    assert ckpt.exists()
    payload = torch.load(ckpt, map_location="cpu", weights_only=False)
    model = build_export_model(payload)
    q = model(torch.zeros(1, 12, 20, 10))
    assert q.shape == (1, 7)
    assert torch.isfinite(q).all()


def test_train_ppo_smoke(tmp_path: Path):
    summary = train(_tiny("ppo", tmp_path))
    assert summary["env_steps"] >= 128
    assert (tmp_path / "test_ppo" / "ckpt" / "latest.pt").exists()


def test_train_bc_smoke(tmp_path: Path):
    summary = train(_tiny("bc", tmp_path))
    assert summary["env_steps"] >= 128
    payload = torch.load(tmp_path / "test_bc" / "ckpt" / "latest.pt", map_location="cpu", weights_only=False)
    assert payload["kind"] == "bc"
