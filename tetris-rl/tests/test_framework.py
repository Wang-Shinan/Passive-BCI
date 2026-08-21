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


def test_frame_stack_shapes():
    from tetris_rl.vec_env import make_vec_env

    env = make_vec_env(3, seed=1, frame_stack=4, vec_backend="sync")
    obs = env.reset(1)
    assert obs.shape == (3, 48, 20, 10)
    nxt, rew, done, info = env.step(np.zeros(3, dtype=np.int64), seed=1)
    assert nxt.shape == obs.shape
    assert rew.shape == (3,)
    assert done.shape == (3,)
    env.close()


def test_frame_stack_stride():
    from tetris_rl.vec_env import make_vec_env

    env = make_vec_env(2, seed=3, frame_stack=4, frame_stride=3, vec_backend="sync")
    obs = env.reset(3)
    assert obs.shape == (2, 48, 20, 10)
    for _ in range(7):
        obs, _, _, _ = env.step(np.zeros(2, dtype=np.int64), seed=3)
    assert obs.shape == (2, 48, 20, 10)
    env.close()


def test_train_dagger_smoke(tmp_path: Path):
    summary = train(_tiny("dagger", tmp_path))
    assert summary["env_steps"] >= 128
    payload = torch.load(tmp_path / "test_dagger" / "ckpt" / "latest.pt", map_location="cpu", weights_only=False)
    assert payload["kind"] == "dagger"


def test_train_iql_smoke(tmp_path: Path):
    summary = train(_tiny("iql", tmp_path))
    assert summary["env_steps"] >= 128
    payload = torch.load(tmp_path / "test_iql" / "ckpt" / "latest.pt", map_location="cpu", weights_only=False)
    assert payload["kind"] == "iql"
    model = build_export_model(payload)
    q = model(torch.zeros(1, 12, 20, 10))
    assert q.shape == (1, 7)


def test_train_pqn_smoke(tmp_path: Path):
    summary = train(_tiny("pqn", tmp_path))
    assert summary["env_steps"] >= 128
    payload = torch.load(tmp_path / "test_pqn" / "ckpt" / "latest.pt", map_location="cpu", weights_only=False)
    assert payload["kind"] == "pqn"
    model = build_export_model(payload)
    q = model(torch.zeros(1, 12, 20, 10))
    assert q.shape == (1, 7)


def test_train_ppo_stacked(tmp_path: Path):
    cfg = _tiny("ppo", tmp_path)
    cfg.frame_stack = 4
    cfg.width = 32
    cfg.depth = 2
    cfg.hidden = 64
    cfg.run_name = "test_ppo_stack"
    summary = train(cfg)
    assert summary["env_steps"] >= 128
    payload = torch.load(tmp_path / "test_ppo_stack" / "ckpt" / "latest.pt", map_location="cpu", weights_only=False)
    model = build_export_model(payload)
    q = model(torch.zeros(1, 48, 20, 10))
    assert q.shape == (1, 7)
