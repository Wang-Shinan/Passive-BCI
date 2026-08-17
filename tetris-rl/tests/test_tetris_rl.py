"""Tests for Tetris RL Python package."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from tetris_rl.agent import DqnAgent
from tetris_rl.engine import RL_ACTION_NAMES, board_fingerprint, create_game, rl_step
from tetris_rl.env import TetrisEnv
from tetris_rl.model import TetrisDQN
from tetris_rl.reward import compute_reward
from tetris_rl.rng import mulberry32


def test_parity_fixture_matches():
    fixture_path = Path(__file__).resolve().parents[1] / "fixtures" / "parity_trajectories.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
    fixture = fixtures[0]
    rng = mulberry32(fixture["seed"])
    state = create_game(fixture["seed"])
    fps = [board_fingerprint(state)]
    for action_name in fixture["actions"]:
        state = rl_step(state, action_name, rng, fixture["cellsPerSec"], instant_anim=True)
        fps.append(board_fingerprint(state))
    assert fps == fixture["fingerprints"]


def test_env_step_contract():
    env = TetrisEnv()
    obs, _ = env.reset(seed=11)
    assert obs.shape == (12, 20, 10)
    obs2, reward, terminated, truncated, info = env.step(0)
    assert obs2.shape == obs.shape
    assert isinstance(reward, float)
    assert terminated in (True, False)
    assert truncated is False
    assert "lines" in info


def test_reward_on_line_clear():
    prev = create_game(5)
    nxt = create_game(5)
    nxt.lines = 2
    reward = compute_reward(prev, nxt, 2)
    assert reward > 0


def test_onnx_export_smoke(tmp_path):
    model = TetrisDQN()
    model.eval()
    dummy = torch.zeros(1, 12, 20, 10)
    onnx_path = tmp_path / "model.onnx"
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["observation"],
        output_names=["q_values"],
        opset_version=17,
    )
    assert onnx_path.exists()
    assert onnx_path.stat().st_size > 1000


def test_heuristic_clears_lines():
    env = TetrisEnv()
    from tetris_rl.heuristic import HeuristicPlanner

    planner = HeuristicPlanner()
    env.reset(seed=100)
    info = {"lines": 0}
    for _ in range(200):
        action = planner.act(env.state, env._rng_fn)
        _, _, terminated, truncated, info = env.step(action)
        if terminated or truncated:
            break
    assert info["lines"] >= 5


def test_agent_select_action():
    agent = DqnAgent(device=torch.device("cpu"), seed=0)
    obs = np.zeros((12, 20, 10), dtype=np.float32)
    action = agent.select_action(obs, explore=False)
    assert 0 <= action < len(RL_ACTION_NAMES)
