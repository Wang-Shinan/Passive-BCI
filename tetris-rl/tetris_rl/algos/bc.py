"""Behavioral cloning from the placement heuristic."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from ..config import TrainConfig
from ..model import ActorCritic


class BCLearner:
    def __init__(self, cfg: TrainConfig, device: torch.device, obs_shape: tuple[int, ...]):
        self.cfg = cfg
        self.device = device
        self.net = ActorCritic(width=cfg.width, hidden=cfg.hidden).to(device)
        self.optimizer = optim.Adam(self.net.parameters(), lr=cfg.lr)
        self.loss_fn = nn.CrossEntropyLoss()
        cap = max(cfg.bc_batch * 8, 16_384)
        self.obs = np.zeros((cap, *obs_shape), dtype=np.float32)
        self.actions = np.zeros(cap, dtype=np.int64)
        self.cap = cap
        self.size = 0
        self.idx = 0
        self.env_steps = 0
        self.updates = 0
        self._use_amp = cfg.precision == "bf16" and device.type == "cuda"

    def remember(self, obs: np.ndarray, actions: np.ndarray) -> None:
        n = obs.shape[0]
        for i in range(n):
            self.obs[self.idx] = obs[i]
            self.actions[self.idx] = actions[i]
            self.idx = (self.idx + 1) % self.cap
            self.size = min(self.size + 1, self.cap)
        self.env_steps += n

    def act(self, obs: np.ndarray, *, explore: bool) -> np.ndarray:
        tensor = torch.from_numpy(obs).to(self.device)
        with torch.no_grad():
            logits = self.net.logits(tensor)
            if explore:
                dist = torch.distributions.Categorical(logits=logits)
                return dist.sample().cpu().numpy().astype(np.int64)
            return logits.argmax(dim=1).cpu().numpy().astype(np.int64)

    def observe(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_obs: np.ndarray,
        dones: np.ndarray,
    ) -> None:
        self.remember(obs, actions)

    def update(self) -> dict[str, float]:
        if self.size < self.cfg.bc_batch:
            return {}
        idx = np.random.randint(0, self.size, size=self.cfg.bc_batch)
        obs = torch.from_numpy(self.obs[idx]).to(self.device)
        actions = torch.from_numpy(self.actions[idx]).to(self.device)
        ctx = torch.autocast(device_type="cuda", dtype=torch.bfloat16) if self._use_amp else torch.autocast(
            device_type="cpu", enabled=False
        )
        with ctx:
            logits = self.net.logits(obs)
            loss = self.loss_fn(logits.float(), actions)
        self.optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.net.parameters(), self.cfg.max_grad_norm)
        self.optimizer.step()
        self.updates += 1
        with torch.no_grad():
            acc = float((logits.argmax(dim=1) == actions).float().mean().item())
        return {"loss": float(loss.item()), "bc_acc": acc}

    def greedy_q_or_logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net.logits(obs)

    def checkpoint(self) -> dict[str, Any]:
        return {
            "kind": "bc",
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

    def to_ppo(self) -> "PPOLearner":
        from .ppo import PPOLearner

        ppo = PPOLearner(self.cfg, self.device, self.cfg.num_envs, self.obs.shape[1:])
        ppo.net.load_state_dict(self.net.state_dict())
        ppo.env_steps = self.env_steps
        return ppo
