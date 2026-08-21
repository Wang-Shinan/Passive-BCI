"""Implicit Q-Learning (Kostrikov et al. 2022) from heuristic trajectories."""

from __future__ import annotations

from random import Random
from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.distributions import Categorical

from ..config import TrainConfig
from ..engine import RL_ACTION_NAMES
from ..model import ActorCritic, DuelingDQN
from .dqn import CircularReplay


class IQLLearner:
    def __init__(self, cfg: TrainConfig, device: torch.device, obs_shape: tuple[int, ...]):
        self.cfg = cfg
        self.device = device
        self.rng = Random(cfg.seed)
        in_channels = int(obs_shape[0])
        self.actor = ActorCritic(
            width=cfg.width, hidden=cfg.hidden, depth=cfg.depth, in_channels=in_channels
        ).to(device)
        self.q = DuelingDQN(
            width=cfg.width, hidden=cfg.hidden, depth=cfg.depth, in_channels=in_channels
        ).to(device)
        self.q_target = DuelingDQN(
            width=cfg.width, hidden=cfg.hidden, depth=cfg.depth, in_channels=in_channels
        ).to(device)
        self.q_target.load_state_dict(self.q.state_dict())
        self.actor_opt = optim.Adam(self.actor.parameters(), lr=cfg.lr)
        self.q_opt = optim.Adam(self.q.parameters(), lr=cfg.lr)
        self.replay = CircularReplay(cfg.buffer_size, obs_shape)
        self.env_steps = 0
        self.updates = 0
        self._calls = 0
        self._use_amp = cfg.precision == "bf16" and device.type == "cuda"
        self.n_actions = len(RL_ACTION_NAMES)

    @property
    def net(self) -> ActorCritic:
        return self.actor

    def act(self, obs: np.ndarray, *, explore: bool) -> np.ndarray:
        tensor = torch.from_numpy(obs).to(self.device)
        with torch.no_grad():
            logits = self.actor.logits(tensor)
            if explore:
                return Categorical(logits=logits).sample().cpu().numpy().astype(np.int64)
            return logits.argmax(dim=1).cpu().numpy().astype(np.int64)

    def observe(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_obs: np.ndarray,
        dones: np.ndarray,
    ) -> None:
        clip = self.cfg.reward_clip
        rew = np.clip(rewards, -clip, clip) if clip > 0 else rewards
        self.replay.push_batch(obs, actions, rew, next_obs, dones)
        self.env_steps += int(obs.shape[0])
        self._calls += 1

    def update(self) -> dict[str, float]:
        if len(self.replay) < self.cfg.batch_size:
            return {}
        if self._calls % max(1, self.cfg.train_interval) != 0:
            return {}
        metrics: dict[str, float] = {}
        for _ in range(max(1, self.cfg.train_updates)):
            metrics = self._train_once()
        return metrics

    def _train_once(self) -> dict[str, float]:
        obs, actions, rewards, next_obs, dones = self.replay.sample(self.cfg.batch_size, self.rng)
        obs_t = torch.from_numpy(obs).to(self.device)
        next_t = torch.from_numpy(next_obs).to(self.device)
        act_t = torch.from_numpy(actions).to(self.device)
        rew_t = torch.from_numpy(rewards).to(self.device)
        done_t = torch.from_numpy(dones).to(self.device)
        tau = float(self.cfg.iql_expectile)
        temp = max(1e-6, float(self.cfg.iql_temperature))
        ctx = torch.autocast(device_type="cuda", dtype=torch.bfloat16) if self._use_amp else torch.autocast(
            device_type="cpu", enabled=False
        )
        with torch.no_grad():
            q_sa = self.q_target(obs_t).gather(1, act_t.unsqueeze(1)).squeeze(1)
            _, v_next = self.actor(next_t)
            q_target = rew_t + self.cfg.gamma * v_next * (1.0 - done_t)

        with ctx:
            logits, v = self.actor(obs_t)
            q_pred = self.q(obs_t).gather(1, act_t.unsqueeze(1)).squeeze(1)
            diff = q_sa - v
            weight = torch.where(diff > 0, tau, 1.0 - tau).detach()
            v_loss = (weight * diff.pow(2)).mean()
            q_loss = 0.5 * (q_pred.float() - q_target.float()).pow(2).mean()
            logp = Categorical(logits=logits.float()).log_prob(act_t)
            exp_a = ((q_sa - v).detach() / temp).exp().clamp(max=100.0)
            pi_loss = -(exp_a * logp).mean()
            actor_loss = v_loss.float() + pi_loss.float()

        self.actor_opt.zero_grad(set_to_none=True)
        actor_loss.backward()
        nn.utils.clip_grad_norm_(self.actor.parameters(), self.cfg.max_grad_norm)
        self.actor_opt.step()

        self.q_opt.zero_grad(set_to_none=True)
        q_loss.backward()
        nn.utils.clip_grad_norm_(self.q.parameters(), self.cfg.max_grad_norm)
        self.q_opt.step()

        self.updates += 1
        if self.updates % max(1, self.cfg.target_sync) == 0:
            self.q_target.load_state_dict(self.q.state_dict())
        return {
            "loss": float((q_loss + actor_loss).item()),
            "q_loss": float(q_loss.item()),
            "v_loss": float(v_loss.item()),
            "pi_loss": float(pi_loss.item()),
            "replay": float(len(self.replay)),
        }

    def greedy_q_or_logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.actor.logits(obs)

    def checkpoint(self) -> dict[str, Any]:
        return {
            "kind": "iql",
            "policy": self.actor.state_dict(),
            "q": self.q.state_dict(),
            "q_target": self.q_target.state_dict(),
            "actor_opt": self.actor_opt.state_dict(),
            "q_opt": self.q_opt.state_dict(),
            "env_steps": self.env_steps,
            "updates": self.updates,
            "width": self.cfg.width,
            "hidden": self.cfg.hidden,
            "depth": self.cfg.depth,
            "in_channels": int(self.q.backbone[0].in_channels),
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.actor.load_state_dict(payload["policy"])
        if "q" in payload:
            self.q.load_state_dict(payload["q"])
        if "q_target" in payload:
            self.q_target.load_state_dict(payload["q_target"])
        else:
            self.q_target.load_state_dict(self.q.state_dict())
        if "actor_opt" in payload:
            self.actor_opt.load_state_dict(payload["actor_opt"])
        if "q_opt" in payload:
            self.q_opt.load_state_dict(payload["q_opt"])
        self.env_steps = int(payload.get("env_steps") or payload.get("step") or 0)
        self.updates = int(payload.get("updates") or 0)
