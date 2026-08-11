"""Typed channel contracts.

The central invariant is that an absent epoch is never represented by a
numerical zero. A neutral observed verdict has ``value == 0.5``; an absent
verdict has ``value is None`` and an explicit reason.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Tuple


VerdictStatus = Literal["observed", "artifact_rejected", "no_response"]


@dataclass(frozen=True)
class EpochVerdict:
    value: Optional[float]
    confidence: float
    latency_ms: Optional[float]
    artifact_rejected: bool
    status: VerdictStatus = "observed"

    def __post_init__(self) -> None:
        if self.status == "observed":
            if self.value is None or not 0.0 <= self.value <= 1.0:
                raise ValueError("observed verdicts require value in [0, 1]")
            if self.latency_ms is None or self.latency_ms < 0:
                raise ValueError("observed verdicts require non-negative latency")
            if self.artifact_rejected:
                raise ValueError("observed verdict cannot be artifact rejected")
        else:
            if self.value is not None:
                raise ValueError("absent verdicts must not carry a numeric value")
            if self.latency_ms is not None:
                raise ValueError("absent verdicts must not carry latency")
            if self.confidence != 0.0:
                raise ValueError("absent verdict confidence must be zero")
            if self.artifact_rejected != (self.status == "artifact_rejected"):
                raise ValueError("artifact flag and status disagree")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must lie in [0, 1]")

    @property
    def is_absent(self) -> bool:
        return self.status != "observed"

    @classmethod
    def rejected(cls) -> "EpochVerdict":
        return cls(
            value=None,
            confidence=0.0,
            latency_ms=None,
            artifact_rejected=True,
            status="artifact_rejected",
        )

    @classmethod
    def no_response(cls) -> "EpochVerdict":
        return cls(
            value=None,
            confidence=0.0,
            latency_ms=None,
            artifact_rejected=False,
            status="no_response",
        )


@dataclass(frozen=True)
class BehavioralBit:
    """Free trial-level completion information paired with every epoch."""

    completed: bool
    timed_out: bool

    def __post_init__(self) -> None:
        if self.completed and self.timed_out:
            raise ValueError("a trial cannot be both completed and timed out")


@dataclass(frozen=True)
class TonicState:
    workload: float
    engagement: float
    confidence: float
    window_ms: int
    cheap_estimate: float

    def __post_init__(self) -> None:
        for name in ("workload", "engagement", "confidence", "cheap_estimate"):
            value = getattr(self, name)
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must lie in [0, 1]")
        if self.window_ms <= 0:
            raise ValueError("window_ms must be positive")


@dataclass(frozen=True)
class EpochObservation:
    event_id: str
    source: Literal["gate", "checkpoint"]
    verdict: EpochVerdict
    behavior: BehavioralBit
    tonic: TonicState
    structural_prior: Tuple[float, ...]

    def __post_init__(self) -> None:
        if not self.structural_prior:
            raise ValueError("structural prior cannot be empty")
        if any(x < 0.0 for x in self.structural_prior):
            raise ValueError("structural prior must be non-negative")
        if abs(sum(self.structural_prior) - 1.0) > 1e-9:
            raise ValueError("structural prior must sum to one")
