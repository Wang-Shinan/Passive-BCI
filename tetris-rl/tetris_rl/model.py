"""Shared Tetris networks: DQN, Dueling DQN, Actor-Critic."""

from __future__ import annotations

import torch
import torch.nn as nn

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from .engine import RL_ACTION_NAMES

OBS_SHAPE = (RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)
ACTION_COUNT = len(RL_ACTION_NAMES)


def conv_backbone(width: int = 64) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(RL_OBS_CHANNELS, width, kernel_size=3, padding=1),
        nn.ReLU(inplace=True),
        nn.Conv2d(width, width, kernel_size=3, padding=1),
        nn.ReLU(inplace=True),
        nn.Conv2d(width, width, kernel_size=3, padding=1),
        nn.ReLU(inplace=True),
        nn.Flatten(),
    )


def feature_dim(width: int = 64) -> int:
    return width * RL_OBS_ROWS * RL_OBS_COLS


class TetrisDQN(nn.Module):
    """Original small CNN used by the first trainer / browser export."""

    def __init__(self, action_count: int = ACTION_COUNT):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(RL_OBS_CHANNELS, 32, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(64 * RL_OBS_ROWS * RL_OBS_COLS, 256),
            nn.ReLU(inplace=True),
            nn.Linear(256, action_count),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class DuelingDQN(nn.Module):
    def __init__(self, action_count: int = ACTION_COUNT, width: int = 64, hidden: int = 512):
        super().__init__()
        self.backbone = conv_backbone(width)
        dim = feature_dim(width)
        self.value = nn.Sequential(nn.Linear(dim, hidden), nn.ReLU(inplace=True), nn.Linear(hidden, 1))
        self.adv = nn.Sequential(
            nn.Linear(dim, hidden), nn.ReLU(inplace=True), nn.Linear(hidden, action_count)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.backbone(x)
        v = self.value(z)
        a = self.adv(z)
        return v + a - a.mean(dim=1, keepdim=True)


class ActorCritic(nn.Module):
    def __init__(self, action_count: int = ACTION_COUNT, width: int = 64, hidden: int = 512):
        super().__init__()
        self.backbone = conv_backbone(width)
        dim = feature_dim(width)
        self.policy = nn.Sequential(
            nn.Linear(dim, hidden), nn.ReLU(inplace=True), nn.Linear(hidden, action_count)
        )
        self.value = nn.Sequential(nn.Linear(dim, hidden), nn.ReLU(inplace=True), nn.Linear(hidden, 1))

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        z = self.backbone(x)
        return self.policy(z), self.value(z).squeeze(-1)

    def logits(self, x: torch.Tensor) -> torch.Tensor:
        z = self.backbone(x)
        return self.policy(z)
