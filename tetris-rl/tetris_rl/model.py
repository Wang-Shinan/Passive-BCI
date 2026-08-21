"""Shared Tetris networks: DQN, Dueling DQN, Actor-Critic."""

from __future__ import annotations

import torch
import torch.nn as nn

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from .engine import RL_ACTION_NAMES

OBS_SHAPE = (RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)
ACTION_COUNT = len(RL_ACTION_NAMES)


class ResidualBlock(nn.Module):
    def __init__(self, width: int):
        super().__init__()
        self.conv1 = nn.Conv2d(width, width, kernel_size=3, padding=1)
        self.conv2 = nn.Conv2d(width, width, kernel_size=3, padding=1)
        self.act = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.act(self.conv1(x))
        y = self.conv2(y)
        return self.act(x + y)


def conv_backbone(in_channels: int = RL_OBS_CHANNELS, width: int = 64, depth: int = 2) -> nn.Sequential:
    layers: list[nn.Module] = [
        nn.Conv2d(in_channels, width, kernel_size=3, padding=1),
        nn.ReLU(inplace=True),
    ]
    for _ in range(max(1, depth)):
        layers.append(ResidualBlock(width))
    layers.append(nn.Flatten())
    return nn.Sequential(*layers)


def feature_dim(width: int = 64) -> int:
    return width * RL_OBS_ROWS * RL_OBS_COLS


def count_parameters(module: nn.Module) -> int:
    return sum(p.numel() for p in module.parameters())


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
    def __init__(
        self,
        action_count: int = ACTION_COUNT,
        width: int = 64,
        hidden: int = 512,
        depth: int = 2,
        in_channels: int = RL_OBS_CHANNELS,
    ):
        super().__init__()
        self.backbone = conv_backbone(in_channels, width, depth)
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
    def __init__(
        self,
        action_count: int = ACTION_COUNT,
        width: int = 64,
        hidden: int = 512,
        depth: int = 2,
        in_channels: int = RL_OBS_CHANNELS,
    ):
        super().__init__()
        self.backbone = conv_backbone(in_channels, width, depth)
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


class PQNNet(nn.Module):
    """Dueling Q-network with LayerNorm on features (PQN, Gallici et al. 2024)."""

    def __init__(
        self,
        action_count: int = ACTION_COUNT,
        width: int = 64,
        hidden: int = 512,
        depth: int = 2,
        in_channels: int = RL_OBS_CHANNELS,
    ):
        super().__init__()
        self.backbone = conv_backbone(in_channels, width, depth)
        dim = feature_dim(width)
        self.ln = nn.LayerNorm(dim)
        self.value = nn.Sequential(nn.Linear(dim, hidden), nn.ReLU(inplace=True), nn.Linear(hidden, 1))
        self.adv = nn.Sequential(
            nn.Linear(dim, hidden), nn.ReLU(inplace=True), nn.Linear(hidden, action_count)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.ln(self.backbone(x))
        v = self.value(z)
        a = self.adv(z)
        return v + a - a.mean(dim=1, keepdim=True)


class AfterstateNet(nn.Module):
    """Shared MLP that scores one afterstate. Input [..., F] -> [...]."""

    def __init__(self, in_dim: int = 9, hidden: int = 64, depth: int = 2):
        super().__init__()
        layers: list[nn.Module] = [nn.Linear(in_dim, hidden), nn.ReLU()]
        for _ in range(max(0, depth - 1)):
            layers += [nn.Linear(hidden, hidden), nn.ReLU()]
        layers.append(nn.Linear(hidden, 1))
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


class AfterstateCNN(nn.Module):
    """Same residual CNN as the H20 policy, but it scores one afterstate board."""

    def __init__(
        self,
        width: int = 384,
        hidden: int = 4096,
        depth: int = 10,
        in_channels: int = RL_OBS_CHANNELS,
    ):
        super().__init__()
        self.backbone = conv_backbone(in_channels, width, depth)
        dim = feature_dim(width)
        self.head = nn.Sequential(
            nn.Linear(dim, hidden),
            nn.ReLU(inplace=True),
            nn.Linear(hidden, 1),
        )
        nn.init.zeros_(self.head[-1].weight)
        nn.init.zeros_(self.head[-1].bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.head(self.backbone(x.reshape(-1, *x.shape[-3:]))).squeeze(-1)
        if x.dim() == 4:
            return z
        return z.reshape(*x.shape[:-3])
