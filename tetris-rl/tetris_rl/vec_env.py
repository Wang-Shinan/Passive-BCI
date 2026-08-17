"""Synchronous vector of TetrisEnv (CPU stepping, GPU-friendly batches)."""

from __future__ import annotations

import numpy as np

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from .env import TetrisEnv


class SyncVectorEnv:
    def __init__(
        self,
        num_envs: int,
        seed: int,
        gravity_min: float = 1.0,
        gravity_max: float = 6.0,
    ):
        if num_envs < 1:
            raise ValueError("num_envs must be >= 1")
        self.num_envs = num_envs
        self.envs = [
            TetrisEnv(gravity_min=gravity_min, gravity_max=gravity_max, seed=seed + i)
            for i in range(num_envs)
        ]
        self._episode = np.zeros(num_envs, dtype=np.int64)

    @property
    def obs_shape(self) -> tuple[int, int, int]:
        return (RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)

    def reset(self, seed: int) -> np.ndarray:
        obs = []
        for i, env in enumerate(self.envs):
            o, _ = env.reset(seed=seed + i + int(self._episode[i]) * 1009)
            obs.append(o)
        return np.stack(obs, axis=0)

    def step(self, actions: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
        next_obs = np.empty((self.num_envs, *self.obs_shape), dtype=np.float32)
        rewards = np.empty(self.num_envs, dtype=np.float32)
        dones = np.zeros(self.num_envs, dtype=np.bool_)
        infos: list[dict] = []
        for i, env in enumerate(self.envs):
            o, r, terminated, truncated, info = env.step(int(actions[i]))
            done = bool(terminated or truncated)
            if done:
                self._episode[i] += 1
                o, _ = env.reset(seed=seed + i + int(self._episode[i]) * 1009)
            next_obs[i] = o
            rewards[i] = r
            dones[i] = done
            infos.append(info)
        return next_obs, rewards, dones, infos
