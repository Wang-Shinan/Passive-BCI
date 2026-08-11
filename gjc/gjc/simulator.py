"""Bit-exact Gated Joint Control simulator.

This is a compact substrate for the proposal's architectural experiments. It
does not claim to reproduce human motor dynamics. Counterfactuals substitute
role policies (remove that role's deterministic deficit) while replaying the
same random tape, never action traces.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, FrozenSet, List, Sequence, Tuple

import numpy as np

from .contracts import BehavioralBit
from .shapley import exact_shapley


ROLES: Tuple[str, ...] = ("yaw", "pitch", "thrust")


@dataclass(frozen=True)
class TrialConfig:
    seed: int
    checkpoint_deadlines: bool = True
    gate_count: int = 15
    checkpoint_every: int = 5
    trial_deadline_s: float = 55.0
    action_load: float = 0.0


@dataclass(frozen=True)
class EventTruth:
    event_id: str
    source: str
    index: int
    violated: bool
    exact_credit: Tuple[float, float, float]
    structural_prior: Tuple[float, float, float]


@dataclass(frozen=True)
class TrialResult:
    seed: int
    checkpoint_deadlines: bool
    gates_passed: int
    elapsed_s: float
    behavior: BehavioralBit
    events: Tuple[EventTruth, ...]
    trial_credit: Tuple[float, float, float]

    @property
    def violation_events(self) -> Tuple[EventTruth, ...]:
        return tuple(event for event in self.events if event.violated)


@dataclass(frozen=True)
class _Gate:
    difficulty: float
    tolerance: float
    deficits: Tuple[float, float, float]
    base_time_s: float


def _softmax(values: Sequence[float], temperature: float = 0.7) -> Tuple[float, ...]:
    xs = np.asarray(values, dtype=float) / temperature
    xs -= xs.max()
    weights = np.exp(xs)
    weights /= weights.sum()
    return tuple(float(x) for x in weights)


class GJCSimulator:
    def _tape(self, config: TrialConfig) -> Tuple[_Gate, ...]:
        rng = np.random.default_rng(config.seed)
        gates: List[_Gate] = []
        for _ in range(config.gate_count):
            difficulty = float(rng.uniform(0.15, 1.0))
            # Thrust has a slightly larger mean effect, while each lateral role
            # dominates on different gates. The random tape is fixed by seed.
            active_lateral = int(rng.integers(0, 2))
            yaw_mean = 0.08 + 0.34 * difficulty + (0.20 if active_lateral == 0 else 0.0)
            pitch_mean = 0.08 + 0.34 * difficulty + (0.20 if active_lateral == 1 else 0.0)
            thrust_mean = 0.14 + 0.42 * difficulty
            deficits = (
                max(0.0, float(rng.normal(yaw_mean, 0.15))),
                max(0.0, float(rng.normal(pitch_mean, 0.15))),
                max(0.0, float(rng.normal(thrust_mean, 0.17))),
            )
            tolerance = float(1.68 + rng.normal(0.0, 0.15))
            base_time_s = float(2.3 + 0.9 * difficulty + rng.uniform(0.0, 0.4))
            gates.append(
                _Gate(
                    difficulty=difficulty,
                    tolerance=tolerance,
                    deficits=deficits,
                    base_time_s=base_time_s,
                )
            )
        return tuple(gates)

    @staticmethod
    def _remaining_deficit(gate: _Gate, coalition: FrozenSet[str]) -> float:
        return sum(
            deficit
            for role, deficit in zip(ROLES, gate.deficits)
            if role not in coalition
        )

    def _gate_passes(self, gate: _Gate, coalition: FrozenSet[str]) -> bool:
        return self._remaining_deficit(gate, coalition) <= gate.tolerance

    def _elapsed_to(
        self,
        gates: Sequence[_Gate],
        stop: int,
        coalition: FrozenSet[str],
        action_load: float,
    ) -> float:
        elapsed = 0.0
        for gate in gates[:stop]:
            residual_thrust = gate.deficits[2] if "thrust" not in coalition else 0.0
            communication_overhead = 0.32 * abs(action_load)
            elapsed += gate.base_time_s + 1.7 * residual_thrust + communication_overhead
            if not self._gate_passes(gate, coalition):
                elapsed += 0.35
        return elapsed

    @staticmethod
    def _event_prior(deficits: Sequence[float], seed: int) -> Tuple[float, float, float]:
        # A dependency-graph prior is informative but intentionally imperfect.
        rng = np.random.default_rng(seed)
        proxy = np.maximum(
            0.01,
            0.65 * np.asarray(deficits)
            + 0.35 * rng.lognormal(mean=-1.1, sigma=0.65, size=3),
        )
        return _softmax(proxy)

    def run(self, config: TrialConfig) -> TrialResult:
        gates = self._tape(config)
        events: List[EventTruth] = []
        gates_passed = 0

        for index, gate in enumerate(gates, start=1):
            value: Callable[[FrozenSet[str]], float] = (
                lambda coalition, g=gate: float(self._gate_passes(g, coalition))
            )
            observed = bool(value(frozenset()))
            if observed:
                gates_passed += 1
            phi = exact_shapley(ROLES, value)
            events.append(
                EventTruth(
                    event_id=f"{config.seed}:gate:{index}",
                    source="gate",
                    index=index,
                    violated=not observed,
                    exact_credit=tuple(float(x) for x in phi),
                    structural_prior=self._event_prior(
                        gate.deficits, config.seed * 1009 + index
                    ),
                )
            )

            if (
                config.checkpoint_deadlines
                and index % config.checkpoint_every == 0
            ):
                checkpoint_deadline = (
                    config.trial_deadline_s * index / config.gate_count
                )
                required_passes = index - 1

                def checkpoint_value(
                    coalition: FrozenSet[str],
                    stop: int = index,
                    deadline: float = checkpoint_deadline,
                    required: int = required_passes,
                ) -> float:
                    passed = sum(
                        self._gate_passes(candidate, coalition)
                        for candidate in gates[:stop]
                    )
                    elapsed = self._elapsed_to(
                        gates, stop, coalition, config.action_load
                    )
                    return float(passed >= required and elapsed <= deadline)

                observed_checkpoint = bool(checkpoint_value(frozenset()))
                checkpoint_phi = exact_shapley(ROLES, checkpoint_value)
                accumulated = np.sum(
                    [gate_item.deficits for gate_item in gates[:index]], axis=0
                )
                events.append(
                    EventTruth(
                        event_id=f"{config.seed}:checkpoint:{index}",
                        source="checkpoint",
                        index=index,
                        violated=not observed_checkpoint,
                        exact_credit=tuple(float(x) for x in checkpoint_phi),
                        structural_prior=self._event_prior(
                            accumulated, config.seed * 2017 + index
                        ),
                    )
                )

        elapsed = self._elapsed_to(
            gates, len(gates), frozenset(), config.action_load
        )
        completed = gates_passed == config.gate_count and elapsed <= config.trial_deadline_s
        behavior = BehavioralBit(completed=completed, timed_out=elapsed > config.trial_deadline_s)
        trial_credit = tuple(
            float(sum(event.exact_credit[role] for event in events))
            for role in range(len(ROLES))
        )
        return TrialResult(
            seed=config.seed,
            checkpoint_deadlines=config.checkpoint_deadlines,
            gates_passed=gates_passed,
            elapsed_s=elapsed,
            behavior=behavior,
            events=tuple(events),
            trial_credit=trial_credit,
        )
