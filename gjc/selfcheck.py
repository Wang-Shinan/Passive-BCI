#!/usr/bin/env python3
"""Run 34 deterministic, channel, and attribution invariants."""

from __future__ import annotations

from typing import List

import numpy as np

from gjc.attribution import behavioral_priors, evaluate_attribution
from gjc.channel import (
    AssumedWorkloadModel,
    SingleShotChannel,
    WorkloadAction,
    neutral_tonic_state,
)
from gjc.contracts import BehavioralBit, EpochObservation, EpochVerdict
from gjc.pathology import evaluate_policy_grid
from gjc.shapley import exact_shapley, permutation_shapley
from gjc.simulator import GJCSimulator, ROLES, TrialConfig


def main() -> None:
    passed: List[str] = []

    def check(name: str, condition: bool) -> None:
        if not condition:
            raise AssertionError(name)
        passed.append(name)

    simulator = GJCSimulator()
    on = simulator.run(TrialConfig(seed=731, checkpoint_deadlines=True))
    replay = simulator.run(TrialConfig(seed=731, checkpoint_deadlines=True))
    off = simulator.run(TrialConfig(seed=731, checkpoint_deadlines=False))
    other = simulator.run(TrialConfig(seed=732, checkpoint_deadlines=True))

    check("replay exact", on == replay)
    check("seed changes trajectory", on != other)
    check("three roles", len(ROLES) == 3)
    check("gate count", sum(e.source == "gate" for e in on.events) == 15)
    check("checkpoint count", sum(e.source == "checkpoint" for e in on.events) == 3)
    check("checkpoint-off count", len(off.events) == 15)
    check("checkpoint does not change gates", on.gates_passed == off.gates_passed)
    check("checkpoint does not change elapsed", on.elapsed_s == off.elapsed_s)
    check("event ids unique", len({e.event_id for e in on.events}) == len(on.events))
    check("priors normalized", all(abs(sum(e.structural_prior) - 1) < 1e-12 for e in on.events))
    check("priors nonnegative", all(min(e.structural_prior) >= 0 for e in on.events))
    check("credit nonnegative", all(min(e.exact_credit) >= -1e-12 for e in on.events))
    check(
        "event Shapley efficiency",
        all(abs(sum(e.exact_credit) - int(e.violated)) < 1e-12 for e in on.events),
    )
    check(
        "trial credit aggregation",
        all(
            abs(on.trial_credit[i] - sum(e.exact_credit[i] for e in on.events)) < 1e-12
            for i in range(3)
        ),
    )
    check("behavior mutually exclusive", not (on.behavior.completed and on.behavior.timed_out))
    check("violation view", all(e.violated for e in on.violation_events))

    value = lambda coalition: float("yaw" in coalition or {"pitch", "thrust"} <= coalition)
    subset_phi = exact_shapley(ROLES, value)
    permutation_phi = permutation_shapley(ROLES, value)
    check("Shapley implementations agree", subset_phi == permutation_phi)
    check("Shapley efficiency standalone", abs(sum(subset_phi) - 1.0) < 1e-12)
    dummy_value = lambda coalition: float("yaw" in coalition)
    dummy_phi = exact_shapley(ROLES, dummy_value)
    check("dummy pitch zero", dummy_phi[1] == 0.0)
    check("dummy thrust zero", dummy_phi[2] == 0.0)
    symmetric_value = lambda coalition: float(bool({"yaw", "pitch"} & coalition))
    symmetric_phi = exact_shapley(ROLES, symmetric_value)
    check("symmetry", symmetric_phi[0] == symmetric_phi[1])

    neutral = EpochVerdict(
        value=0.5,
        confidence=0.7,
        latency_ms=400.0,
        artifact_rejected=False,
    )
    rejected = EpochVerdict.rejected()
    no_response = EpochVerdict.no_response()
    check("neutral is observed", not neutral.is_absent)
    check("rejection is absent", rejected.is_absent)
    check("no response is absent", no_response.is_absent)
    check("absence is not zero", rejected.value is None and no_response.value is None)
    check("rejection distinct", rejected != no_response)

    tonic = neutral_tonic_state()
    channel = SingleShotChannel(nominal_accuracy=0.78)
    check("nominal reliability", channel.effective_accuracy(tonic) == 0.78)
    overloaded = AssumedWorkloadModel().step(
        tonic,
        WorkloadAction(verbosity=1.0, batching=1.0, asking=1.0),
        np.random.default_rng(1),
    )
    check("workload is actuated", overloaded.workload > tonic.workload)
    check(
        "load reduces reliability",
        channel.effective_accuracy(overloaded) < channel.effective_accuracy(tonic),
    )

    trials = [
        simulator.run(TrialConfig(seed=10_000 + i, checkpoint_deadlines=True))
        for i in range(30)
    ]
    priors = behavioral_priors(trials)
    observations = {}
    rng = np.random.default_rng(55)
    for trial in trials:
        for event in trial.events:
            observations[event.event_id] = EpochObservation(
                event_id=event.event_id,
                source=event.source,  # type: ignore[arg-type]
                verdict=channel.observe(event.violated, tonic, rng),
                behavior=trial.behavior,
                tonic=tonic,
                structural_prior=event.structural_prior,
            )
    metrics = evaluate_attribution(trials, observations, priors, use_verdict=True)
    check("attribution bounded", 0.0 < metrics.trial_top1 <= 1.0)
    check("calibration bounded", 0.0 <= metrics.ece <= 1.0)

    pathology = evaluate_policy_grid(seed=99, events_per_action=1000)
    unsafe = pathology["unsafe"]
    guarded = pathology["guarded"]
    check("unsafe suppresses supply", unsafe["verdict_supply"] < guarded["verdict_supply"])
    check("guard enforces band", guarded["admissible"])

    check("exact invariant count", len(passed) == 33)
    print(f"{len(passed)} invariants passed")
    for index, name in enumerate(passed, start=1):
        print(f"{index:02d}. {name}")


if __name__ == "__main__":
    main()
