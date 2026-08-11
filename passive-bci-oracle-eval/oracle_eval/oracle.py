"""Oracle rating from shortest-path progress + EEG-like noise."""

from __future__ import annotations

from typing import Callable

import numpy as np

from .graph import Graph, all_dist_to_goal, is_optimal_action

RATING_LEVELS = (-1.0, -0.5, 0.0, 0.5, 1.0)


def oracle_rating(dist: np.ndarray, state: int, action: int) -> float:
    """
    Map pathfinding progress to the same scale as the web demo (-1..1).

    - optimal progress (distance ↓): +1
    - sideways (distance same): 0
    - regress (distance ↑): -1
    """
    before = int(dist[state])
    after = int(dist[action])
    if after < before:
        return 1.0
    if after > before:
        return -1.0
    return 0.0


def random_rating(rng: np.random.Generator) -> float:
    """Uniform draw from discrete rating levels (chance-level decoder)."""
    return float(RATING_LEVELS[int(rng.integers(0, len(RATING_LEVELS)))])


def corrupt_rating(
    clean: float,
    sigma: float,
    flip_prob: float,
    rng: np.random.Generator,
) -> float:
    """Gaussian noise + optional discrete flip among {-1,-0.5,0,0.5,1}."""
    levels = np.asarray(RATING_LEVELS, dtype=float)
    value = clean
    if flip_prob > 0 and rng.random() < flip_prob:
        others = levels[levels != clean]
        value = float(others[rng.integers(0, len(others))])
    if sigma > 0:
        value = float(value + rng.normal(0.0, sigma))
    return float(np.clip(value, -1.0, 1.0))


def make_feedback_fn(
    graph: Graph,
    *,
    sigma: float = 0.0,
    flip_prob: float = 0.0,
    miss_prob: float = 0.0,
    seed: int = 0,
) -> Callable[[int, int], float | None]:
    """
    Returns feedback(state, action) -> rating or None (decoder miss / no update).
    """
    dist = all_dist_to_goal(graph)
    rng = np.random.default_rng(seed)

    def feedback(state: int, action: int) -> float | None:
        if miss_prob > 0 and rng.random() < miss_prob:
            return None
        clean = oracle_rating(dist, state, action)
        if sigma <= 0 and flip_prob <= 0:
            return clean
        return corrupt_rating(clean, sigma, flip_prob, rng)

    feedback.dist = dist  # type: ignore[attr-defined]
    feedback.is_optimal = lambda s, a: is_optimal_action(dist, s, a)  # type: ignore[attr-defined]
    return feedback
