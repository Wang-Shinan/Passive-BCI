"""DQN agent with replay buffer."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from random import Random

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from .engine import RL_ACTION_NAMES
from .model import TetrisDQN


@dataclass
class Transition:
    obs: np.ndarray
    action: int
    reward: float
    next_obs: np.ndarray
    done: bool


class ReplayBuffer:
    def __init__(self, capacity: int = 50_000):
        self.capacity = capacity
        self.data: deque[Transition] = deque(maxlen=capacity)

    def push(self, transition: Transition) -> None:
        self.data.append(transition)

    def sample(self, batch_size: int, rng: Random) -> list[Transition]:
        indices = rng.sample(range(len(self.data)), batch_size)
        return [self.data[i] for i in indices]

    def __len__(self) -> int:
        return len(self.data)


class DqnAgent:
    def __init__(
        self,
        device: torch.device,
        lr: float = 3e-4,
        gamma: float = 0.99,
        buffer_size: int = 50_000,
        batch_size: int = 64,
        target_sync: int = 1000,
        seed: int = 0,
    ):
        self.device = device
        self.gamma = gamma
        self.batch_size = batch_size
        self.target_sync = target_sync
        self.rng = Random(seed)
        self.steps = 0

        self.policy = TetrisDQN().to(device)
        self.target = TetrisDQN().to(device)
        self.target.load_state_dict(self.policy.state_dict())
        self.optimizer = optim.Adam(self.policy.parameters(), lr=lr)
        self.loss_fn = nn.SmoothL1Loss()
        self.replay = ReplayBuffer(buffer_size)

        self.eps_start = 1.0
        self.eps_end = 0.05
        self.eps_decay = 60_000

    @property
    def epsilon(self) -> float:
        frac = min(1.0, self.steps / max(1, self.eps_decay))
        return self.eps_start + (self.eps_end - self.eps_start) * frac

    def select_action(self, obs: np.ndarray, explore: bool = True) -> int:
        if explore and self.rng.random() < self.epsilon:
            return self.rng.randrange(len(RL_ACTION_NAMES))
        with torch.no_grad():
            tensor = torch.from_numpy(obs).unsqueeze(0).to(self.device)
            q = self.policy(tensor)
            return int(q.argmax(dim=1).item())

    def remember(
        self,
        obs: np.ndarray,
        action: int,
        reward: float,
        next_obs: np.ndarray,
        done: bool,
    ) -> None:
        self.replay.push(Transition(obs, action, reward, next_obs, done))

    def train_step(self) -> float | None:
        if len(self.replay) < self.batch_size:
            return None

        batch = self.replay.sample(self.batch_size, self.rng)
        obs = torch.from_numpy(np.stack([t.obs for t in batch])).to(self.device)
        actions = torch.tensor([t.action for t in batch], device=self.device)
        rewards = torch.tensor([t.reward for t in batch], dtype=torch.float32, device=self.device)
        next_obs = torch.from_numpy(np.stack([t.next_obs for t in batch])).to(self.device)
        dones = torch.tensor([t.done for t in batch], dtype=torch.float32, device=self.device)

        q_values = self.policy(obs).gather(1, actions.unsqueeze(1)).squeeze(1)
        with torch.no_grad():
            next_q = self.target(next_obs).max(dim=1).values
            target = rewards + self.gamma * next_q * (1.0 - dones)

        loss = self.loss_fn(q_values, target)
        self.optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.policy.parameters(), 10.0)
        self.optimizer.step()

        self.steps += 1
        if self.steps % self.target_sync == 0:
            self.target.load_state_dict(self.policy.state_dict())

        return float(loss.item())
