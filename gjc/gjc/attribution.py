"""Posterior event credit under a single-shot observation channel."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Mapping, Sequence, Tuple

import numpy as np

from .channel import SingleShotChannel
from .contracts import EpochObservation
from .simulator import EventTruth, ROLES, TrialResult


def _clip_probability(value: float) -> float:
    return float(min(1.0 - 1e-9, max(1e-9, value)))


def behavioral_priors(trials: Iterable[TrialResult]) -> Dict[Tuple[bool, bool], float]:
    """Fit p(violation | completion, timeout) with beta-binomial smoothing."""

    counts: Dict[Tuple[bool, bool], List[int]] = {}
    for trial in trials:
        key = (trial.behavior.completed, trial.behavior.timed_out)
        count = counts.setdefault(key, [1, 2])  # Beta(1, 1)
        for event in trial.events:
            count[0] += int(event.violated)
            count[1] += 1
    return {key: positives / total for key, (positives, total) in counts.items()}


def posterior_violation(
    observation: EpochObservation,
    prior: float,
) -> float:
    """Bayesian inversion of one noisy observation.

    Missing/rejected epochs return the behavioral prior. They never become a
    neutral or negative observation.
    """

    if observation.verdict.is_absent:
        return prior
    observed_positive = bool(observation.verdict.value >= 0.5)
    accuracy = _clip_probability(observation.verdict.confidence)
    prior = _clip_probability(prior)
    likelihood_positive = accuracy if observed_positive else 1.0 - accuracy
    likelihood_negative = 1.0 - accuracy if observed_positive else accuracy
    numerator = likelihood_positive * prior
    denominator = numerator + likelihood_negative * (1.0 - prior)
    return numerator / denominator


def event_credit(
    observation: EpochObservation,
    prior: float,
    use_verdict: bool,
) -> Tuple[float, ...]:
    probability = posterior_violation(observation, prior) if use_verdict else prior
    return tuple(probability * weight for weight in observation.structural_prior)


@dataclass(frozen=True)
class AttributionMetrics:
    event_mae: float
    brier: float
    ece: float
    trial_top1: float
    sign_agreement: float
    observed_fraction: float


def expected_calibration_error(
    probabilities: Sequence[float],
    labels: Sequence[int],
    bins: int = 10,
) -> float:
    ps = np.asarray(probabilities, dtype=float)
    ys = np.asarray(labels, dtype=float)
    total = len(ps)
    ece = 0.0
    for lower in np.linspace(0.0, 1.0, bins, endpoint=False):
        upper = lower + 1.0 / bins
        mask = (ps >= lower) & (ps < upper if upper < 1.0 else ps <= upper)
        if not np.any(mask):
            continue
        ece += float(mask.mean()) * abs(float(ps[mask].mean() - ys[mask].mean()))
    return ece


def evaluate_attribution(
    trials: Sequence[TrialResult],
    observations: Mapping[str, EpochObservation],
    priors: Mapping[Tuple[bool, bool], float],
    use_verdict: bool,
) -> AttributionMetrics:
    truth_credit: List[float] = []
    predicted_credit: List[float] = []
    labels: List[int] = []
    probabilities: List[float] = []
    observed = 0
    trial_correct = 0
    sign_correct = 0
    sign_total = 0

    for trial in trials:
        prior = priors[(trial.behavior.completed, trial.behavior.timed_out)]
        predicted_trial = np.zeros(len(ROLES), dtype=float)
        true_trial = np.asarray(trial.trial_credit, dtype=float)
        for event in trial.events:
            observation = observations[event.event_id]
            prediction = event_credit(observation, prior, use_verdict)
            probability = (
                posterior_violation(observation, prior) if use_verdict else prior
            )
            predicted_trial += np.asarray(prediction)
            truth_credit.extend(event.exact_credit)
            predicted_credit.extend(prediction)
            labels.append(int(event.violated))
            probabilities.append(probability)
            observed += int(not observation.verdict.is_absent)
            for true_value, predicted_value in zip(event.exact_credit, prediction):
                sign_correct += int((true_value > 1e-12) == (predicted_value >= 0.5))
                sign_total += 1
        if true_trial.sum() > 1e-12:
            trial_correct += int(int(np.argmax(predicted_trial)) == int(np.argmax(true_trial)))

    truth_array = np.asarray(truth_credit)
    predicted_array = np.asarray(predicted_credit)
    label_array = np.asarray(labels)
    probability_array = np.asarray(probabilities)
    eligible_trials = sum(sum(trial.trial_credit) > 1e-12 for trial in trials)
    return AttributionMetrics(
        event_mae=float(np.mean(np.abs(truth_array - predicted_array))),
        brier=float(np.mean((probability_array - label_array) ** 2)),
        ece=expected_calibration_error(probabilities, labels),
        trial_top1=trial_correct / max(1, eligible_trials),
        sign_agreement=sign_correct / max(1, sign_total),
        observed_fraction=observed / max(1, len(labels)),
    )
