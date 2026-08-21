from __future__ import annotations

from typing import Any, Protocol

import numpy as np
import torch


class Learner(Protocol):
    def act(self, obs: np.ndarray, *, explore: bool) -> np.ndarray: ...
    def observe(
        self,
        obs: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_obs: np.ndarray,
        dones: np.ndarray,
    ) -> None: ...
    def update(self) -> dict[str, float]: ...
    def greedy_q_or_logits(self, obs: torch.Tensor) -> torch.Tensor: ...
    def checkpoint(self) -> dict[str, Any]: ...
    def load(self, payload: dict[str, Any]) -> None: ...
