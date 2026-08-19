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
    no_survive = compute_reward(prev, nxt, 2, survival_bonus=0.0)
    assert no_survive == reward - 0.05
    messy = create_game(5)
    messy.board[-1][0] = 1
    messy.board[-3][0] = 1
    assert compute_reward(prev, messy, 0, survival_bonus=0.0) == 0.0


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


def test_rotate_does_not_cancel_gravity():
    rng = mulberry32(1)
    state = create_game(1)
    start_y = state.piece.y if state.piece else 0
    for _ in range(8):
        state = rl_step(state, "rotateCW", rng, 4.0, instant_anim=True)
    assert state.piece is not None
    assert state.piece.y > start_y


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


def test_lookahead_bfs_clears_lines():
    env = TetrisEnv()
    from tetris_rl.heuristic import HeuristicPlanner

    planner = HeuristicPlanner(depth=3, beam=16, workers=0)
    env.reset(seed=100)
    info = {"lines": 0}
    for _ in range(120):
        action = planner.act(env.state, env._rng_fn)
        _, _, terminated, truncated, info = env.step(action)
        if terminated or truncated:
            break
    planner.close()
    assert info["lines"] >= 5


def test_gpu_lock_batch_matches_cpu():
    from tetris_rl.env import TetrisEnv
    from tetris_rl.heuristic import HeuristicPlanner
    from tetris_rl.search import _lock_and_score, iter_candidates
    from tetris_rl.search_gpu import lock_score_batch

    def _check(state):
        moved = [m for _, m in iter_candidates(state)]
        if len(moved) < 8:
            return
        cpu = [_lock_and_score(m, state.lines) for m in moved]
        gpu_locked, gpu_scores = lock_score_batch(moved, state.lines, torch.device("cpu"))
        for (st_a, sc_a), st_b, sc_b in zip(cpu, gpu_locked, gpu_scores):
            assert st_a.lines == st_b.lines
            assert st_a.game_over == st_b.game_over
            assert st_a.board == st_b.board
            assert abs(sc_a - sc_b) < 1e-4

    _check(create_game(7))
    env = TetrisEnv()
    planner = HeuristicPlanner(depth=1, device="none")
    env.reset(seed=10000)
    for _ in range(55):
        env.step(planner.act(env.state, env._rng_fn))
    planner.close()
    _check(env.state)


def test_afterstate_pack_and_net():
    from tetris_rl.afterstate import AFTERSTATE_DIM, enumerate_placements, pack_placements
    from tetris_rl.model import AfterstateNet, count_parameters

    state = create_game(7)
    placements = enumerate_placements(state)
    assert placements
    feats, mask, teacher = pack_placements(placements)
    assert feats.shape[1] == AFTERSTATE_DIM
    assert mask[teacher]
    net = AfterstateNet(AFTERSTATE_DIM, hidden=32, depth=2)
    assert count_parameters(net) < 10_000
    scores = net(torch.from_numpy(feats[mask]))
    assert scores.shape[0] == int(mask.sum())


def test_search_depth4_returns_das_plan():
    from tetris_rl.search import best_placement_actions

    state = create_game(7)
    plan = best_placement_actions(state, depth=4, beam=32, workers=0)
    assert plan
    assert plan[-1] in ("hardDrop", "noop")
    assert all(a in RL_ACTION_NAMES for a in plan)


def test_agent_select_action():
    agent = DqnAgent(device=torch.device("cpu"), seed=0)
    obs = np.zeros((12, 20, 10), dtype=np.float32)
    action = agent.select_action(obs, explore=False)
    assert 0 <= action < len(RL_ACTION_NAMES)


def test_play_plan_returns_reward():
    from tetris_rl.afterstate import enumerate_placements, play_plan

    env = TetrisEnv(survival_bonus=0.0)
    env.reset(seed=11)
    placements = enumerate_placements(env.state)
    done, info, rew = play_plan(env, placements[0].plan)
    assert isinstance(done, bool)
    assert "lines" in info
    assert isinstance(rew, float)


def test_afterstate_ppo_update_and_bc_resume():
    from tetris_rl.afterstate import enumerate_placements, pack_placements, play_plan
    from tetris_rl.algos.afterstate import AfterstateLearner
    from tetris_rl.config import TrainConfig

    cfg = TrainConfig(
        algo="afterstate_ppo",
        num_envs=2,
        rollout_steps=4,
        ppo_epochs=1,
        ppo_minibatch=4,
        hidden=32,
        depth=1,
        lr=1e-3,
        entropy_coef=0.01,
        afterstate_encoder="mlp",
        survival_bonus=0.0,
        reward_clip=0.0,
    )
    learner = AfterstateLearner(cfg, torch.device("cpu"))
    env = TetrisEnv(survival_bonus=0.0)
    env.reset(seed=7)
    for t in range(4):
        for i in range(2):
            if env.state.game_over or not env.state.piece:
                env.reset(seed=8 + t * 2 + i)
            placements = enumerate_placements(env.state)
            feats, mask, _ = pack_placements(placements)
            idx, logp, value = learner.act_dist(feats, mask, sample=True)
            idx = min(idx, len(placements) - 1)
            done, _, rew = play_plan(env, placements[idx].plan)
            learner.observe_ppo(i, feats, mask, idx, logp, value, rew, done)
            if done:
                env.reset(seed=20 + t * 2 + i)
    stats = learner.update(np.zeros(2, dtype=np.float32))
    assert "policy_loss" in stats
    assert learner.checkpoint()["kind"] == "afterstate_ppo"

    bc = AfterstateLearner(
        TrainConfig(algo="afterstate", hidden=32, depth=1, afterstate_encoder="mlp"),
        torch.device("cpu"),
    )
    learner.env_steps = 99
    learner.load(bc.checkpoint(), policy_only=True)
    assert learner.env_steps == 0
    assert learner.updates == 0

