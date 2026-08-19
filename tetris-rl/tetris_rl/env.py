"""Gymnasium environment for Tetris RL."""

from __future__ import annotations

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS, encode_observation
from .engine import (
    RL_ACTION_NAMES,
    RL_DECISION_DT_SEC,
    copy_game_state,
    create_game,
    rl_step,
)
from .reward import compute_reward
from .rng import mulberry32


class TetrisEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(
        self,
        gravity_min: float = 1.0,
        gravity_max: float = 6.0,
        seed: int | None = None,
        survival_bonus: float = 0.05,
    ):
        super().__init__()
        self.gravity_min = gravity_min
        self.gravity_max = gravity_max
        self.survival_bonus = survival_bonus
        self._seed = seed if seed is not None else 1
        self._rng_fn = mulberry32(self._seed)
        self._cells_per_sec = gravity_min

        self.action_space = spaces.Discrete(len(RL_ACTION_NAMES))
        self.observation_space = spaces.Box(
            low=0.0,
            high=1.0,
            shape=(RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS),
            dtype=np.float32,
        )

        self.state = create_game(self._seed)
        self._prev_lines = 0

    def _gravity_norm(self) -> float:
        span = max(1e-6, self.gravity_max - self.gravity_min)
        return float(np.clip((self._cells_per_sec - self.gravity_min) / span, 0.0, 1.0))

    def _obs(self) -> np.ndarray:
        return encode_observation(self.state, self._gravity_norm())

    def reset(self, *, seed: int | None = None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            self._seed = seed
        elif options and "seed" in options:
            self._seed = int(options["seed"])
        self._rng_fn = mulberry32(self._seed)
        import random as pyrandom

        self._cells_per_sec = pyrandom.Random(self._seed).uniform(
            self.gravity_min, self.gravity_max
        )
        self.state = create_game(self._seed)
        self._prev_lines = 0
        return self._obs(), {}

    def step(self, action: int):
        prev = copy_game_state(self.state)
        prev_lines = prev.lines
        action_name = RL_ACTION_NAMES[int(action)]
        self.state = rl_step(
            self.state,
            action_name,
            self._rng_fn,
            self._cells_per_sec,
            RL_DECISION_DT_SEC,
            instant_anim=True,
        )
        lines_delta = self.state.lines - prev_lines
        reward = compute_reward(
            prev, self.state, lines_delta, survival_bonus=self.survival_bonus
        )
        terminated = self.state.game_over
        truncated = False
        return self._obs(), reward, terminated, truncated, {
            "lines": self.state.lines,
            "score": self.state.score,
        }
