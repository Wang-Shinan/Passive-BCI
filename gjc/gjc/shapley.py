"""Exact Shapley values for the three-role simulator."""

from __future__ import annotations

import itertools
import math
from typing import Callable, FrozenSet, Iterable, Mapping, Sequence, Tuple


Coalition = FrozenSet[str]
ValueFunction = Callable[[Coalition], float]


def coalitions(players: Sequence[str]) -> Iterable[Coalition]:
    for size in range(len(players) + 1):
        for group in itertools.combinations(players, size):
            yield frozenset(group)


def exact_shapley(
    players: Sequence[str],
    value: ValueFunction,
) -> Tuple[float, ...]:
    """Subset-enumeration Shapley values."""

    n = len(players)
    result = []
    for player in players:
        total = 0.0
        others = [p for p in players if p != player]
        for subset in coalitions(others):
            weight = (
                math.factorial(len(subset))
                * math.factorial(n - len(subset) - 1)
                / math.factorial(n)
            )
            total += weight * (value(subset | {player}) - value(subset))
        result.append(total)
    return tuple(result)


def permutation_shapley(
    players: Sequence[str],
    value: ValueFunction,
) -> Tuple[float, ...]:
    """Exact permutation average used as an independent self-check."""

    totals = {player: 0.0 for player in players}
    permutations = list(itertools.permutations(players))
    for order in permutations:
        coalition: Coalition = frozenset()
        before = value(coalition)
        for player in order:
            coalition = coalition | {player}
            after = value(coalition)
            totals[player] += after - before
            before = after
    return tuple(totals[player] / len(permutations) for player in players)


def table_value(table: Mapping[Coalition, float]) -> ValueFunction:
    return lambda coalition: table[frozenset(coalition)]
