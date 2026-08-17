"""Small CNN DQN for Tetris."""

from __future__ import annotations

import torch
import torch.nn as nn

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from .engine import RL_ACTION_NAMES


class TetrisDQN(nn.Module):
    def __init__(self, action_count: int = len(RL_ACTION_NAMES)):
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
