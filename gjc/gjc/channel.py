"""Single-shot phasic channel and assumed tonic workload dynamics."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .contracts import EpochVerdict, TonicState


def clipped(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return float(min(high, max(low, value)))


@dataclass(frozen=True)
class WorkloadAction:
    """Load-relevant dimensions of an otherwise task-directed action."""

    verbosity: float = 0.0
    batching: float = 0.0
    asking: float = 0.0

    def __post_init__(self) -> None:
        for value in (self.verbosity, self.batching, self.asking):
            if not -1.0 <= value <= 1.0:
                raise ValueError("workload action dimensions must lie in [-1, 1]")


@dataclass(frozen=True)
class AssumedWorkloadModel:
    """Documented assumed f(w, a), deliberately not fitted to human data."""

    persistence: float = 0.72
    target: float = 0.5
    verbosity_gain: float = 0.20
    batching_gain: float = 0.13
    asking_gain: float = 0.15

    def step(
        self,
        state: TonicState,
        action: WorkloadAction,
        rng: np.random.Generator,
    ) -> TonicState:
        drive = (
            self.verbosity_gain * action.verbosity
            + self.batching_gain * action.batching
            + self.asking_gain * action.asking
        )
        next_workload = clipped(
            self.persistence * state.workload
            + (1.0 - self.persistence) * self.target
            + drive
            + float(rng.normal(0.0, 0.018))
        )
        # Both overload and underload reduce engagement.
        engagement = clipped(
            0.98 - 1.55 * abs(next_workload - self.target)
            + float(rng.normal(0.0, 0.012))
        )
        cheap = clipped(next_workload + float(rng.normal(0.0, 0.08)))
        return TonicState(
            workload=next_workload,
            engagement=engagement,
            confidence=0.85,
            window_ms=5000,
            cheap_estimate=cheap,
        )


@dataclass(frozen=True)
class SingleShotChannel:
    """p(o | r_true, w, e) with exactly one draw per event."""

    nominal_accuracy: float
    base_rejection: float = 0.03

    def __post_init__(self) -> None:
        if not 0.5 <= self.nominal_accuracy <= 1.0:
            raise ValueError("nominal_accuracy must lie in [0.5, 1]")

    def effective_accuracy(self, tonic: TonicState) -> float:
        load_quality = clipped(1.0 - 1.35 * abs(tonic.workload - 0.5))
        capacity = (self.nominal_accuracy - 0.5) * load_quality * tonic.engagement
        return clipped(0.5 + capacity, 0.5, 1.0)

    def rejection_probability(self, tonic: TonicState) -> float:
        return clipped(
            self.base_rejection
            + 0.50 * abs(tonic.workload - 0.5)
            + 0.30 * (1.0 - tonic.engagement),
            0.0,
            0.78,
        )

    def observe(
        self,
        violated: bool,
        tonic: TonicState,
        rng: np.random.Generator,
    ) -> EpochVerdict:
        if float(rng.random()) < self.rejection_probability(tonic):
            return EpochVerdict.rejected()

        accuracy = self.effective_accuracy(tonic)
        decoded = violated if float(rng.random()) < accuracy else not violated
        # Graded output retains a calibrated distance from neutrality.
        strength = 0.5 + 0.5 * accuracy
        value = strength if decoded else 1.0 - strength
        latency = (
            260.0
            + 360.0 * abs(tonic.workload - 0.5)
            + 120.0 * (1.0 - tonic.engagement)
            + float(rng.normal(0.0, 18.0))
        )
        return EpochVerdict(
            value=clipped(value),
            confidence=accuracy,
            latency_ms=max(0.0, latency),
            artifact_rejected=False,
            status="observed",
        )


def neutral_tonic_state() -> TonicState:
    return TonicState(
        workload=0.5,
        engagement=1.0,
        confidence=1.0,
        window_ms=5000,
        cheap_estimate=0.5,
    )
