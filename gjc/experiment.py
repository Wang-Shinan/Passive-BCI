#!/usr/bin/env python3
"""Stage 1 noise-sensitivity and Stage 2b pathology experiments."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path
from typing import Dict, List, Sequence

import numpy as np

from gjc.attribution import behavioral_priors, evaluate_attribution
from gjc.channel import SingleShotChannel, neutral_tonic_state
from gjc.contracts import EpochObservation
from gjc.pathology import evaluate_policy_grid
from gjc.simulator import GJCSimulator, TrialConfig, TrialResult


def make_trials(
    simulator: GJCSimulator,
    seeds: Sequence[int],
    checkpoints: bool,
) -> List[TrialResult]:
    return [
        simulator.run(
            TrialConfig(seed=seed, checkpoint_deadlines=checkpoints)
        )
        for seed in seeds
    ]


def make_observations(
    trials: Sequence[TrialResult],
    accuracy: float,
    seed: int,
) -> Dict[str, EpochObservation]:
    rng = np.random.default_rng(seed)
    tonic = neutral_tonic_state()
    channel = SingleShotChannel(nominal_accuracy=accuracy)
    observations: Dict[str, EpochObservation] = {}
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
    return observations


def checkpoint_summary(trials: Sequence[TrialResult]) -> Dict[str, float]:
    timed_out = [trial for trial in trials if trial.behavior.timed_out]
    silent = [trial for trial in timed_out if not trial.violation_events]
    return {
        "trials": len(trials),
        "timeout_rate": len(timed_out) / len(trials),
        "silent_timeout_rate_among_timeouts": len(silent) / max(1, len(timed_out)),
        "zero_event_rate": sum(not trial.violation_events for trial in trials)
        / len(trials),
        "mean_events": float(np.mean([len(trial.events) for trial in trials])),
        "mean_violation_events": float(
            np.mean([len(trial.violation_events) for trial in trials])
        ),
        "mean_gates_passed": float(np.mean([trial.gates_passed for trial in trials])),
    }


def run(args: argparse.Namespace) -> Dict[str, object]:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    simulator = GJCSimulator()

    print(
        "Experiment 1: checkpoint deadlines should turn silent trial timeouts "
        "into explicit, time-locked events without changing gate dynamics."
    )
    comparison_seeds = list(range(args.seed, args.seed + args.trials))
    checkpoint_off = make_trials(simulator, comparison_seeds, checkpoints=False)
    checkpoint_on = make_trials(simulator, comparison_seeds, checkpoints=True)
    checkpoint_result = {
        "off": checkpoint_summary(checkpoint_off),
        "on": checkpoint_summary(checkpoint_on),
        "paired_gate_counts_identical": all(
            left.gates_passed == right.gates_passed
            for left, right in zip(checkpoint_off, checkpoint_on)
        ),
        "paired_elapsed_identical": all(
            left.elapsed_s == right.elapsed_s
            for left, right in zip(checkpoint_off, checkpoint_on)
        ),
    }
    print(json.dumps(checkpoint_result, indent=2))

    print(
        "Experiment 2: the Stage 1 curve measures posterior-credit error and "
        "calibration as effective single-shot accuracy falls."
    )
    train_seeds = list(
        range(args.seed + 1_000_000, args.seed + 1_000_000 + args.train_trials)
    )
    train_trials = make_trials(simulator, train_seeds, checkpoints=True)
    priors = behavioral_priors(train_trials)
    eval_trials = checkpoint_on
    accuracies = [float(item) / 100.0 for item in args.accuracies.split(",")]
    curve: List[Dict[str, float]] = []
    baseline_metrics = None

    for index, accuracy in enumerate(accuracies):
        observations = make_observations(
            eval_trials,
            accuracy=accuracy,
            seed=args.seed + 7_000_000 + index,
        )
        neural = evaluate_attribution(
            eval_trials, observations, priors, use_verdict=True
        )
        if baseline_metrics is None:
            baseline_metrics = evaluate_attribution(
                eval_trials, observations, priors, use_verdict=False
            )
        baseline_mae = baseline_metrics.event_mae
        row = {
            "effective_accuracy": accuracy,
            **{f"neural_{key}": value for key, value in asdict(neural).items()},
            "behavioral_event_mae": baseline_mae,
            "mae_gain_fraction": (baseline_mae - neural.event_mae) / baseline_mae,
        }
        curve.append(row)
        print(
            f"accuracy={accuracy:.2f} event_MAE={neural.event_mae:.4f} "
            f"gain={row['mae_gain_fraction']:.3f} ECE={neural.ece:.3f} "
            f"top1={neural.trial_top1:.3f}"
        )

    print(
        "Experiment 3: under an explicitly assumed workload response model, "
        "test whether an unsafe selector can look better by suppressing verdicts, "
        "then apply the frozen-model plus two-sided-band block."
    )
    pathology = evaluate_policy_grid(seed=args.seed + 9_000_000)
    print(
        json.dumps(
            {
                "assumption": pathology["assumption"],
                "unsafe": pathology["unsafe"],
                "guarded": pathology["guarded"],
            },
            indent=2,
        )
    )

    result: Dict[str, object] = {
        "schema_version": 1,
        "seed": args.seed,
        "train_trials": args.train_trials,
        "evaluation_trials": args.trials,
        "behavioral_priors": {
            f"completed={key[0]},timed_out={key[1]}": value
            for key, value in priors.items()
        },
        "checkpoint_comparison": checkpoint_result,
        "noise_sensitivity": curve,
        "pathology": pathology,
    }
    result_path = out_dir / "final_info.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Wrote {result_path}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out_dir", required=True)
    parser.add_argument("--seed", type=int, default=20260730)
    parser.add_argument("--trials", type=int, default=600)
    parser.add_argument("--train_trials", type=int, default=300)
    parser.add_argument("--accuracies", default="100,90,80,70,65,55")
    args = parser.parse_args()
    run(args)


if __name__ == "__main__":
    main()
