"""Mulberry32 PRNG — matches src/lib/rng.ts."""

from __future__ import annotations


def mulberry32(seed: int):
    t = seed & 0xFFFFFFFF

    def rng() -> float:
        nonlocal t
        t = (t + 0x6D2B79F5) & 0xFFFFFFFF
        r = ((t ^ (t >> 15)) * (1 | t)) & 0xFFFFFFFF
        r = (r ^ (r + ((r ^ (r >> 7)) * (61 | r)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((r ^ (r >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def shuffle_in_place(arr: list, rng) -> list:
    for i in range(len(arr) - 1, 0, -1):
        j = int(rng() * (i + 1))
        arr[i], arr[j] = arr[j], arr[i]
    return arr
