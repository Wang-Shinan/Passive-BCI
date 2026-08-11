"""Simulated evaluator-degradation pathology and structural block."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, List

import numpy as np

from .channel import (
    AssumedWorkloadModel,
    SingleShotChannel,
    WorkloadAction,
    neutral_tonic_state,
)


@dataclass(frozen=True)
class PolicyPoint:
    load_action: float
    mean_workload: float
    true_violation_rate: float
    apparent_violation_rate: float
    verdict_supply: float
    task_performance: float
    admissible: bool
    frozen_model_score: float


def evaluate_policy_grid(
    seed: int = 9127,
    events_per_action: int = 4000,
) -> Dict[str, object]:
    """Exhibit the exploit under an explicitly assumed f(w, a).

    Apparent violations divide by all scheduled events, mirroring the unsafe
    implementation that collapses absence into zero. The guarded selector:
    (1) restricts workload to a two-sided band, and
    (2) evaluates candidate actions with a frozen nominal observation model.
    """

    workload_model = AssumedWorkloadModel()
    channel = SingleShotChannel(nominal_accuracy=0.78)
    points: List[PolicyPoint] = []

    for index, load_action in enumerate(np.linspace(-1.0, 1.0, 9)):
        rng = np.random.default_rng(seed + index * 100_003)
        tonic = neutral_tonic_state()
        observed_positive = 0
        observed_count = 0
        true_positive = 0
        workload_sum = 0.0
        frozen_score_sum = 0.0
        action = WorkloadAction(
            verbosity=float(load_action),
            batching=float(0.55 * load_action),
            asking=float(0.20 * load_action),
        )

        for _ in range(events_per_action):
            tonic = workload_model.step(tonic, action, rng)
            workload_sum += tonic.workload
            true_rate = min(
                0.90,
                0.22
                + 0.30 * abs(tonic.workload - 0.5)
                + 0.16 * max(0.0, tonic.workload - 0.70),
            )
            violated = bool(rng.random() < true_rate)
            true_positive += int(violated)
            verdict = channel.observe(violated, tonic, rng)
            if not verdict.is_absent:
                observed_count += 1
                observed_positive += int(verdict.value >= 0.5)

            # Frozen-model score blocks action -> reliability gradients. It is
            # an expected score, so it does not add simulation noise.
            nominal = channel.nominal_accuracy
            frozen_score_sum += nominal if violated else 1.0 - nominal

        mean_workload = workload_sum / events_per_action
        deviation = abs(mean_workload - 0.5)
        points.append(
            PolicyPoint(
                load_action=float(load_action),
                mean_workload=mean_workload,
                true_violation_rate=true_positive / events_per_action,
                apparent_violation_rate=observed_positive / events_per_action,
                verdict_supply=observed_count / events_per_action,
                task_performance=max(0.0, 1.0 - 0.85 * deviation),
                admissible=0.30 <= mean_workload <= 0.70,
                frozen_model_score=frozen_score_sum / events_per_action,
            )
        )

    unsafe = min(points, key=lambda point: point.apparent_violation_rate)
    admissible = [point for point in points if point.admissible]
    guarded = min(admissible, key=lambda point: point.frozen_model_score)
    return {
        "assumption": "synthetic workload response f(w,a); no human-calibrated magnitude",
        "unsafe_selected_action": unsafe.load_action,
        "guarded_selected_action": guarded.load_action,
        "unsafe": asdict(unsafe),
        "guarded": asdict(guarded),
        "grid": [asdict(point) for point in points],
    }
