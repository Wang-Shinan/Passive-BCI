"""Deterministic Gated Joint Control substrate."""

from .contracts import (
    BehavioralBit,
    EpochObservation,
    EpochVerdict,
    TonicState,
)
from .simulator import ROLES, GJCSimulator, TrialConfig, TrialResult

__all__ = [
    "BehavioralBit",
    "EpochObservation",
    "EpochVerdict",
    "GJCSimulator",
    "ROLES",
    "TonicState",
    "TrialConfig",
    "TrialResult",
]
