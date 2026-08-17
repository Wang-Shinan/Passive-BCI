"""Double / Dueling / n-step DQN with a circular replay buffer."""

from __future__ import annotations

from collections import deque
from random import Random
from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from ..config import TrainConfig
from ..engine import RL_ACTION_NAMES
from ..model import DuelingDQN, TetrisDQN


class CircularReplay:
    def __init__(self, capacity: int, obs_shape: tuple[int, ...]):
        self.capacity = capacity
        self.obs = np.zeros((capacity, *obs_shape), dtype=np.float16)
        self.next_obs = np.zeros((capacity, *obs_shape), dtype=np.float16)
        self.actions = np.zeros(capacity, dtype=np.int64)
        self.rewards = np.zeros(capacity, dtype=np.float32)
        self.dones = np.zeros(capacity, dtype=np.float32)
        self.size = 0
        self.idx = 0

    def push_batch(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_obs: np.ndarray,
        dones: np.ndarray,
    ) -> None:
        n = obs.shape[0]
        for i in range(n):
            self.obs[self.idx] = obs[i]
            self.next_obs[self.idx] = next_obs[i]
            self.actions[self.idx] = actions[i]
            self.rewards[self.idx] = rewards[i]
            self.dones[self.idx] = float(dones[i])
            self.idx = (self.idx + 1) % self.capacity
            self.size = min(self.size + 1, self.capacity)

    def sample(self, batch_size: int, rng: Random) -> tuple[np.ndarray, ...]:
        indices = np.array(rng.sample(range(self.size), batch_size), dtype=np.int64)
        return (
            self.obs[indices].astype(np.float32),
            self.actions[indices],
            self.rewards[indices],
            self.next_obs[indices].astype(np.float32),
            self.dones[indices],
        )

    def __len__(self) -> int:
        return self.size


class DQNLearner:
    def __init__(self, cfg: TrainConfig, device: torch.device, obs_shape: tuple[int, ...]):
        self.cfg = cfg
        self.device = device
        self.rng = Random(cfg.seed)
        self.n_actions = len(RL_ACTION_NAMES)
        if cfg.dueling:
            self.policy = DuelingDQN(width=cfg.width, hidden=cfg.hidden).to(device)
            self.target = DuelingDQN(width=cfg.width, hidden=cfg.hidden).to(device)
        else:
            self.policy = TetrisDQN().to(device)
            self.target = TetrisDQN().to(device)
        self.target.load_state_dict(self.policy.state_dict())
        self.optimizer = optim.Adam(self.policy.parameters(), lr=cfg.lr)
        self.loss_fn = nn.SmoothL1Loss()
        self.replay = CircularReplay(cfg.buffer_size, obs_shape)
        self.n_step = max(1, cfg.n_step)
        self._nbufs: list[deque[tuple]] = [deque() for _ in range(cfg.num_envs)]
        self.env_steps = 0
        self.updates = 0
        self._calls = 0
        self._use_amp = cfg.precision == "bf16" and device.type == "cuda"

    @property
    def epsilon(self) -> float:
        frac = min(1.0, self.env_steps / max(1, self.cfg.eps_decay))
        return self.cfg.eps_start + (self.cfg.eps_end - self.cfg.eps_start) * frac

    def act(self, obs: np.ndarray, *, explore: bool) -> np.ndarray:
        n = obs.shape[0]
        actions = np.empty(n, dtype=np.int64)
        greedy_mask = np.ones(n, dtype=np.bool_)
        if explore:
            for i in range(n):
                if self.rng.random() < self.epsilon:
                    actions[i] = self.rng.randrange(self.n_actions)
                    greedy_mask[i] = False
        if greedy_mask.any():
            tensor = torch.from_numpy(obs[greedy_mask]).to(self.device)
            with torch.no_grad():
                q = self.policy(tensor)
                picked = q.argmax(dim=1).cpu().numpy()
            actions[greedy_mask] = picked
        return actions

    def observe(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_obs: np.ndarray,
        dones: np.ndarray,
    ) -> None:
        gamma = self.cfg.gamma
        for i in range(obs.shape[0]):
            buf = self._nbufs[i]
            buf.append((obs[i], actions[i], rewards[i], next_obs[i], dones[i]))
            if len(buf) < self.n_step and not dones[i]:
                continue
            while buf and (len(buf) >= self.n_step or dones[i]):
                ret = 0.0
                for k, tr in enumerate(buf):
                    ret += (gamma**k) * float(tr[2])
                    if tr[4]:
                        break
                first = buf[0]
                last = buf[min(self.n_step, len(buf)) - 1]
                done = any(tr[4] for tr in list(buf)[: self.n_step])
                self.replay.push_batch(
                    first[0][None],
                    np.array([first[1]]),
                    np.array([ret], dtype=np.float32),
                    last[3][None],
                    np.array([done]),
                )
                buf.popleft()
                if not dones[i]:
                    break
            if dones[i]:
                buf.clear()
        self.env_steps += obs.shape[0]
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
        gamma_n = self.cfg.gamma**self.n_step
        ctx = torch.autocast(device_type="cuda", dtype=torch.bfloat16) if self._use_amp else torch.autocast(
            device_type="cpu", enabled=False
        )
        with ctx:
            q = self.policy(obs_t).gather(1, act_t.unsqueeze(1)).squeeze(1)
            with torch.no_grad():
                if self.cfg.double:
                    next_a = self.policy(next_t).argmax(dim=1)
                    next_q = self.target(next_t).gather(1, next_a.unsqueeze(1)).squeeze(1)
                else:
                    next_q = self.target(next_t).max(dim=1).values
                target = rew_t + gamma_n * next_q * (1.0 - done_t)
            loss = self.loss_fn(q.float(), target.float())
        self.optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.policy.parameters(), self.cfg.max_grad_norm)
        self.optimizer.step()
        self.updates += 1
        if self.updates % self.cfg.target_sync == 0:
            self.target.load_state_dict(self.policy.state_dict())
        return {"loss": float(loss.item()), "epsilon": self.epsilon, "replay": float(len(self.replay))}

    def greedy_q_or_logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.policy(obs)

    def checkpoint(self) -> dict[str, Any]:
        return {
            "kind": "dqn",
            "policy": self.policy.state_dict(),
            "target": self.target.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "env_steps": self.env_steps,
            "updates": self.updates,
            "dueling": self.cfg.dueling,
            "width": self.cfg.width,
            "hidden": self.cfg.hidden,
        }

    def load(self, payload: dict[str, Any]) -> None:
        self.policy.load_state_dict(payload["policy"])
        if "target" in payload:
            self.target.load_state_dict(payload["target"])
        else:
            self.target.load_state_dict(payload["policy"])
        if "optimizer" in payload:
            self.optimizer.load_state_dict(payload["optimizer"])
        self.env_steps = int(payload.get("env_steps") or payload.get("step") or 0)
        self.updates = int(payload.get("updates") or 0)
