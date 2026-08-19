"""Parallelised Q-Network (Gallici et al. 2024): on-policy Q-learning, no replay."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from ..config import TrainConfig
from ..engine import RL_ACTION_NAMES
from ..model import PQNNet


class PQNLearner:
    def __init__(self, cfg: TrainConfig, device: torch.device, num_envs: int, obs_shape: tuple[int, ...]):
        self.cfg = cfg
        self.device = device
        self.num_envs = num_envs
        self.obs_shape = obs_shape
        self.n_actions = len(RL_ACTION_NAMES)
        self.net = PQNNet(
            width=cfg.width,
            hidden=cfg.hidden,
            depth=cfg.depth,
            in_channels=int(obs_shape[0]),
        ).to(device)
        self.optimizer = optim.Adam(self.net.parameters(), lr=cfg.lr)
        self._use_amp = cfg.precision == "bf16" and device.type == "cuda"
        self.env_steps = 0
        self.updates = 0
        self._reset_rollout()

    def _reset_rollout(self) -> None:
        t = self.cfg.rollout_steps
        n = self.num_envs
        self._i = 0
        self.obs = np.zeros((t, n, *self.obs_shape), dtype=np.float32)
        self.actions = np.zeros((t, n), dtype=np.int64)
        self.rewards = np.zeros((t, n), dtype=np.float32)
        self.dones = np.zeros((t, n), dtype=np.float32)

    @property
    def epsilon(self) -> float:
        frac = min(1.0, self.env_steps / max(1, self.cfg.eps_decay))
        return self.cfg.eps_start + (self.cfg.eps_end - self.cfg.eps_start) * frac

    def act(self, obs: np.ndarray, *, explore: bool) -> np.ndarray:
        tensor = torch.from_numpy(obs).to(self.device)
        with torch.no_grad():
            q = self.net(tensor)
            greedy = q.argmax(dim=1).cpu().numpy().astype(np.int64)
        if not explore:
            return greedy
        n = obs.shape[0]
        actions = greedy.copy()
        for i in range(n):
            if np.random.random() < self.epsilon:
                actions[i] = np.random.randint(self.n_actions)
        return actions

    def observe(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_obs: np.ndarray,
        dones: np.ndarray,
    ) -> None:
        i = self._i
        if i >= self.cfg.rollout_steps:
            return
        clip = self.cfg.reward_clip
        rew = np.clip(rewards, -clip, clip) if clip > 0 else rewards
        self.obs[i] = obs
        self.actions[i] = actions
        self.rewards[i] = rew
        self.dones[i] = dones.astype(np.float32)
        self._last_next_obs = next_obs
        self._i += 1
        self.env_steps += obs.shape[0]

    def update(self) -> dict[str, float]:
        if self._i < self.cfg.rollout_steps:
            return {}
        next_obs = torch.from_numpy(self._last_next_obs).to(self.device)
        with torch.no_grad():
            bootstrap = self.net(next_obs).max(dim=1).values.cpu().numpy()
        ret = self._discounted_returns(bootstrap)
        t, n = self.cfg.rollout_steps, self.num_envs
        b = t * n
        obs_np = self.obs.reshape(b, *self.obs_shape)
        actions_np = self.actions.reshape(b)
        ret_np = ret.reshape(b)

        idx = np.arange(b)
        last: dict[str, float] = {}
        mb_size = min(self.cfg.ppo_minibatch, b)
        ctx = torch.autocast(device_type="cuda", dtype=torch.bfloat16) if self._use_amp else torch.autocast(
            device_type="cpu", enabled=False
        )
        for _ in range(self.cfg.ppo_epochs):
            np.random.shuffle(idx)
            for start in range(0, b, mb_size):
                mb = idx[start : start + mb_size]
                obs_t = torch.from_numpy(np.ascontiguousarray(obs_np[mb])).to(self.device)
                act_t = torch.from_numpy(actions_np[mb]).to(self.device)
                ret_t = torch.from_numpy(ret_np[mb]).to(self.device)
                with ctx:
                    q = self.net(obs_t).gather(1, act_t.unsqueeze(1)).squeeze(1)
                    loss = 0.5 * (q.float() - ret_t.float()).pow(2).mean()
                self.optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), self.cfg.max_grad_norm)
                self.optimizer.step()
                last = {"loss": float(loss.item()), "epsilon": float(self.epsilon)}
        self.updates += 1
        self._reset_rollout()
        return last

    def _discounted_returns(self, bootstrap: np.ndarray) -> np.ndarray:
        t, n = self.cfg.rollout_steps, self.num_envs
        ret = np.zeros((t, n), dtype=np.float32)
        nxt = bootstrap.astype(np.float32)
        gamma = self.cfg.gamma
        for i in reversed(range(t)):
            mask = 1.0 - self.dones[i]
            nxt = self.rewards[i] + gamma * nxt * mask
            ret[i] = nxt
        return ret

    def greedy_q_or_logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net(obs)

    def checkpoint(self) -> dict[str, Any]:
        return {
            "kind": "pqn",
            "policy": self.net.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "env_steps": self.env_steps,
            "updates": self.updates,
            "width": self.cfg.width,
            "hidden": self.cfg.hidden,
            "depth": self.cfg.depth,
            "in_channels": int(self.obs_shape[0]),
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.net.load_state_dict(payload["policy"])
        if "optimizer" in payload:
            self.optimizer.load_state_dict(payload["optimizer"])
        self.env_steps = int(payload.get("env_steps") or payload.get("step") or 0)
        self.updates = int(payload.get("updates") or 0)
