"""Evaluation helpers for Tetris DQN."""

from __future__ import annotations

import random

import numpy as np

from .agent import DqnAgent
from .env import TetrisEnv


def evaluate(agent: DqnAgent, seeds: list[int], max_steps: int = 800) -> dict:
    env = TetrisEnv()
    lines: list[int] = []
    scores: list[int] = []

    for seed in seeds:
        obs, _ = env.reset(seed=seed)
        total_lines = 0
        total_score = 0
        for _ in range(max_steps):
            action = agent.select_action(obs, explore=False)
            obs, reward, terminated, truncated, info = env.step(action)
            total_lines = info["lines"]
            total_score = info["score"]
            if terminated or truncated:
                break
        lines.append(total_lines)
        scores.append(total_score)

    return {
        "mean_lines": float(np.mean(lines)),
        "median_lines": float(np.median(lines)),
        "mean_score": float(np.mean(scores)),
        "cleared_episodes": int(sum(1 for x in lines if x > 0)),
        "episodes": len(seeds),
        "lines": lines,
    }


def random_baseline(seeds: list[int], max_steps: int = 500) -> dict:
    env = TetrisEnv()
    rng = random.Random(0)
    lines: list[int] = []

    for seed in seeds:
        env.reset(seed=seed)
        info = {"lines": 0}
        for _ in range(max_steps):
            action = rng.randrange(env.action_space.n)
            _, _, terminated, truncated, info = env.step(action)
            if terminated or truncated:
                break
        lines.append(info["lines"])

    return {
        "mean_lines": float(np.mean(lines)),
        "cleared_episodes": int(sum(1 for x in lines if x > 0)),
        "episodes": len(seeds),
    }
