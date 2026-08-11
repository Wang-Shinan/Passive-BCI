"""Tabular Q-learning and TAMER."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from .graph import Graph, neighbors


Key = Tuple[int, int]


@dataclass
class QParams:
    alpha: float = 0.4
    gamma: float = 0.9
    epsilon: float = 0.2
    step_penalty: float = -0.05
    goal_reward: float = 1.0


@dataclass
class TamerParams:
    alpha: float = 0.5
    epsilon: float = 0.15
    credit_window: int = 1
    credit_decay: float = 0.5


class ValueTable:
    def __init__(self) -> None:
        self.values: Dict[Key, float] = {}

    def get(self, s: int, a: int) -> float:
        return self.values.get((s, a), 0.0)

    def set(self, s: int, a: int, v: float) -> None:
        self.values[(s, a)] = v

    def copy(self) -> "ValueTable":
        t = ValueTable()
        t.values = dict(self.values)
        return t


def max_q(table: ValueTable, graph: Graph, state: int) -> float:
    acts = neighbors(graph, state)
    if not acts:
        return 0.0
    return max(table.get(state, a) for a in acts)


def best_action(
    table: ValueTable,
    graph: Graph,
    state: int,
    rng: np.random.Generator,
) -> Optional[int]:
    acts = neighbors(graph, state)
    if not acts:
        return None
    best_v = -1e18
    best: List[int] = []
    for a in acts:
        v = table.get(state, a)
        if v > best_v:
            best_v = v
            best = [a]
        elif v == best_v:
            best.append(a)
    return int(best[rng.integers(0, len(best))])


def epsilon_greedy(
    table: ValueTable,
    graph: Graph,
    state: int,
    epsilon: float,
    rng: np.random.Generator,
) -> Optional[int]:
    acts = neighbors(graph, state)
    if not acts:
        return None
    if rng.random() < epsilon:
        return int(acts[rng.integers(0, len(acts))])
    return best_action(table, graph, state, rng)


def td_update(
    table: ValueTable,
    graph: Graph,
    state: int,
    action: int,
    next_state: int,
    human_reward: float,
    params: QParams,
    done: bool,
) -> None:
    env = params.goal_reward if done else params.step_penalty
    total_r = human_reward + env
    old = table.get(state, action)
    bootstrap = 0.0 if done else max_q(table, graph, next_state)
    target = total_r + params.gamma * bootstrap
    table.set(state, action, old + params.alpha * (target - old))


def tamer_update(
    table: ValueTable,
    feedback: float,
    trace: List[Tuple[int, int]],
    params: TamerParams,
) -> None:
    window = max(1, int(params.credit_window))
    decay = float(np.clip(params.credit_decay, 0.0, 1.0))
    recent = trace[-window:]
    if not recent:
        return
    weights = []
    for i in range(len(recent)):
        age = len(recent) - 1 - i
        weights.append(decay**age)
    ssum = sum(weights) or 1.0
    for (s, a), w in zip(recent, weights):
        old = table.get(s, a)
        table.set(s, a, old + params.alpha * (w / ssum) * (feedback - old))
