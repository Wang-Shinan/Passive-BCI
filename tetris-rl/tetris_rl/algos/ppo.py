"""PPO with GAE on a shared actor-critic."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.distributions import Categorical

from ..config import TrainConfig
from ..model import ActorCritic


class PPOLearner:
    def __init__(self, cfg: TrainConfig, device: torch.device, num_envs: int, obs_shape: tuple[int, ...]):
        self.cfg = cfg
        self.device = device
        self.num_envs = num_envs
        self.obs_shape = obs_shape
        self.net = ActorCritic(width=cfg.width, hidden=cfg.hidden).to(device)
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
        self.logp = np.zeros((t, n), dtype=np.float32)
        self.rewards = np.zeros((t, n), dtype=np.float32)
        self.dones = np.zeros((t, n), dtype=np.float32)
        self.values = np.zeros((t, n), dtype=np.float32)

    def act(self, obs: np.ndarray, *, explore: bool) -> np.ndarray:
        tensor = torch.from_numpy(obs).to(self.device)
        with torch.no_grad():
            logits, values = self.net(tensor)
            dist = Categorical(logits=logits)
            if explore:
                actions = dist.sample()
            else:
                actions = logits.argmax(dim=1)
            logp = dist.log_prob(actions)
        self._last_logp = logp.cpu().numpy()
        self._last_value = values.cpu().numpy()
        return actions.cpu().numpy().astype(np.int64)

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
        self.logp[i] = self._last_logp
        self.rewards[i] = rew
        self.dones[i] = dones.astype(np.float32)
        self.values[i] = self._last_value
        self._last_next_obs = next_obs
        self._i += 1
        self.env_steps += obs.shape[0]

    def update(self) -> dict[str, float]:
        if self._i < self.cfg.rollout_steps:
            return {}
        next_obs = torch.from_numpy(self._last_next_obs).to(self.device)
        with torch.no_grad():
            _, next_v = self.net(next_obs)
            next_v = next_v.cpu().numpy()
        adv, ret = self._gae(next_v)
        t, n = self.cfg.rollout_steps, self.num_envs
        b = t * n
        obs = torch.from_numpy(self.obs.reshape(b, *self.obs_shape)).to(self.device)
        actions = torch.from_numpy(self.actions.reshape(b)).to(self.device)
        old_logp = torch.from_numpy(self.logp.reshape(b)).to(self.device)
        adv_t = torch.from_numpy(adv.reshape(b)).to(self.device)
        ret_t = torch.from_numpy(ret.reshape(b)).to(self.device)
        adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)

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
                mb_t = torch.from_numpy(mb).to(self.device)
                with ctx:
                    logits, values = self.net(obs.index_select(0, mb_t))
                    dist = Categorical(logits=logits)
                    logp = dist.log_prob(actions.index_select(0, mb_t))
                    ratio = (logp - old_logp.index_select(0, mb_t)).exp()
                    a = adv_t.index_select(0, mb_t)
                    surr1 = ratio * a
                    surr2 = ratio.clamp(1.0 - self.cfg.clip, 1.0 + self.cfg.clip) * a
                    policy_loss = -torch.min(surr1, surr2).mean()
                    value_loss = 0.5 * (values.float() - ret_t.index_select(0, mb_t)).pow(2).mean()
                    entropy = dist.entropy().mean()
                    loss = (
                        policy_loss
                        + self.cfg.value_coef * value_loss
                        - self.cfg.entropy_coef * entropy
                    )
                self.optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), self.cfg.max_grad_norm)
                self.optimizer.step()
                last = {
                    "loss": float(loss.item()),
                    "policy_loss": float(policy_loss.item()),
                    "value_loss": float(value_loss.item()),
                    "entropy": float(entropy.item()),
                }
        self.updates += 1
        self._reset_rollout()
        return last

    def _gae(self, next_v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        t, n = self.cfg.rollout_steps, self.num_envs
        adv = np.zeros((t, n), dtype=np.float32)
        last_gae = np.zeros(n, dtype=np.float32)
        gamma, lam = self.cfg.gamma, self.cfg.gae_lambda
        for i in reversed(range(t)):
            nxt = next_v if i == t - 1 else self.values[i + 1]
            mask = 1.0 - self.dones[i]
            delta = self.rewards[i] + gamma * nxt * mask - self.values[i]
            last_gae = delta + gamma * lam * mask * last_gae
            adv[i] = last_gae
        ret = adv + self.values
        return adv, ret

    def greedy_q_or_logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net.logits(obs)

    def checkpoint(self) -> dict[str, Any]:
        return {
            "kind": "ppo",
            "policy": self.net.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "env_steps": self.env_steps,
            "updates": self.updates,
            "width": self.cfg.width,
            "hidden": self.cfg.hidden,
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.net.load_state_dict(payload["policy"])
        if "optimizer" in payload:
            self.optimizer.load_state_dict(payload["optimizer"])
        self.env_steps = int(payload.get("env_steps") or payload.get("step") or 0)
        self.updates = int(payload.get("updates") or 0)
