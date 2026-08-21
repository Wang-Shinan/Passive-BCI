"""Placement-level beam BFS / optional MC. Parallel over a layer of locks.

The 7 DAS buttons are not the search tree. Most 7-action sequences only
wiggle the falling piece; the informative branch is a lock (≈30–40 legal
rot/x per piece). 7^2=49 is two button presses; 35^3≈4e4 is three pieces.
``max_nodes`` is a soft cap (0 = unlimited). Prefer ``depth`` + ``beam``.
"""

from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass

from .engine import (
    COLS,
    collides,
    copy_game_state,
    hard_drop,
    instant_resolve_anim,
    move,
    rotate,
    GameState,
)
from .reward import board_potential
from .rng import mulberry32

DEFAULT_DEPTH = 4
DEFAULT_BEAM = 512
# 0 = no cap. 10000 is a comfortable serial budget, not a hard limit.
DEFAULT_MAX_NODES = 0


def resolve_search_workers(workers: int) -> int:
    if workers < 0:
        return max(1, os.cpu_count() or 1)
    return int(workers)


def _try_rotate(state: GameState, times: int) -> GameState | None:
    s = copy_game_state(state)
    for _ in range(times):
        before = s.piece.rot if s.piece else None
        s = rotate(s, 1)
        if not s.piece or s.piece.rot == before:
            if times > 0 and (not s.piece or s.piece.type != "O"):
                return None
    return s


def _try_move_to_x(state: GameState, target_x: int) -> GameState | None:
    s = copy_game_state(state)
    if not s.piece:
        return None
    dx = 1 if target_x > s.piece.x else -1
    guard = 0
    while s.piece and s.piece.x != target_x and guard < COLS + 4:
        before = s.piece.x
        s = move(s, dx)
        if not s.piece or s.piece.x == before:
            return None
        guard += 1
    return s


def _plan(rot: int, x: int, start_x: int) -> list[str]:
    plan = (["rotateCW"] * rot) + (
        ["right"] * max(0, x - start_x) + ["left"] * max(0, start_x - x)
    )
    plan.append("hardDrop")
    return plan or ["hardDrop"]


def iter_candidates(state: GameState) -> list[tuple[list[str], GameState]]:
    """Legal (action plan, pre-drop state) for the current piece."""
    if not state.piece or state.game_over or state.anim:
        return []
    piece = state.piece
    rotations = 1 if piece.type == "O" else 4
    out: list[tuple[list[str], GameState]] = []
    for rot in range(rotations):
        rotated = _try_rotate(state, rot)
        if rotated is None or rotated.piece is None:
            continue
        for x in range(-4, COLS + 4):
            moved = _try_move_to_x(rotated, x)
            if moved is None or moved.piece is None:
                continue
            if collides(moved.board, moved.piece):
                continue
            out.append((_plan(rot, x, piece.x), moved))
    return out


def lock_candidate(moved: GameState, rng) -> GameState:
    dropped = hard_drop(copy_game_state(moved), rng)
    return instant_resolve_anim(dropped, rng)


def leaf_score(state: GameState, lines0: int) -> float:
    score = board_potential(state.board) + 12.0 * (state.lines - lines0)
    if state.game_over:
        score -= 50.0
    return score


def _lock_and_score(moved: GameState, lines0: int) -> tuple[GameState, float]:
    """Detached RNG so search never advances the live env bag."""
    locked = lock_candidate(moved, mulberry32(1))
    return locked, leaf_score(locked, lines0)


@dataclass
class _Node:
    first_plan: list[str]
    state: GameState
    score: float


def _expand_jobs(nodes: list[_Node]) -> list[tuple[list[str], GameState]]:
    jobs: list[tuple[list[str], GameState]] = []
    for node in nodes:
        if node.state.game_over or not node.state.piece:
            continue
        for _, moved in iter_candidates(node.state):
            jobs.append((node.first_plan, moved))
    return jobs


def _eval_jobs(
    jobs: list[tuple[list[str], GameState]],
    lines0: int,
    workers: int,
    pool: ProcessPoolExecutor | None,
    device=None,
) -> list[_Node]:
    if not jobs:
        return []
    if device is not None:
        from .search_gpu import lock_score_batch, should_use_gpu_batch

        if should_use_gpu_batch(len(jobs), device):
            locked, scores = lock_score_batch([m for _, m in jobs], lines0, device)
            return [_Node(fp, st, sc) for (fp, _), st, sc in zip(jobs, locked, scores)]
    if workers <= 1 or pool is None or len(jobs) < 48:
        out: list[_Node] = []
        for first_plan, moved in jobs:
            locked, score = _lock_and_score(moved, lines0)
            out.append(_Node(first_plan, locked, score))
        return out
    futs = [pool.submit(_lock_and_score, moved, lines0) for _, moved in jobs]
    out = []
    for (first_plan, _), fut in zip(jobs, futs):
        locked, score = fut.result()
        out.append(_Node(first_plan, locked, score))
    return out


def _mc_value(after_first: GameState, lines0: int, horizon: int, samples: int, seed: int) -> float:
    if samples <= 0 or horizon <= 0 or after_first.game_over:
        return leaf_score(after_first, lines0)
    total = 0.0
    for i in range(samples):
        rng = mulberry32(seed + 1 + i * 7919)
        s = copy_game_state(after_first)
        for _ in range(horizon):
            if s.game_over or not s.piece:
                break
            cands = iter_candidates(s)
            if not cands:
                break
            best_s: GameState | None = None
            best_v = float("-inf")
            for _, moved in cands:
                locked = lock_candidate(moved, rng)
                v = leaf_score(locked, lines0)
                if v > best_v:
                    best_v = v
                    best_s = locked
            if best_s is None:
                break
            s = best_s
        total += leaf_score(s, lines0)
    return total / samples


def best_placement_actions(
    state: GameState,
    rng=None,
    depth: int = DEFAULT_DEPTH,
    mc_samples: int = 0,
    mc_horizon: int = 3,
    beam: int = DEFAULT_BEAM,
    max_nodes: int = DEFAULT_MAX_NODES,
    workers: int = 0,
    pool: ProcessPoolExecutor | None = None,
    device: str = "none",
) -> list[str]:
    """Realtime DAS plan for the current piece after a placement beam BFS.

    ``depth`` is pieces ahead (1=greedy, 2=known next, 3–4=bag). ``beam``
    keeps the best boards each ply. ``max_nodes=0`` means no node cap.
    """
    del rng
    if not state.piece or state.game_over or state.anim:
        return ["noop"]

    lines0 = state.lines
    depth = max(1, int(depth))
    beam = max(1, int(beam))
    max_nodes = max(0, int(max_nodes))
    workers = resolve_search_workers(workers)
    try:
        from .search_gpu import resolve_search_device

        torch_device = resolve_search_device(device)
    except Exception:
        torch_device = None
    own_pool = False
    if torch_device is not None and getattr(torch_device, "type", "") == "cuda":
        workers = 0
        pool = None
    elif workers > 1 and pool is None:
        pool = ProcessPoolExecutor(max_workers=workers)
        own_pool = True

    try:
        root_jobs = [(plan, moved) for plan, moved in iter_candidates(state)]
        if not root_jobs:
            return ["hardDrop"]
        layer = _eval_jobs(root_jobs, lines0, workers, pool, torch_device)
        used = len(layer)
        if not layer:
            return ["hardDrop"]

        for _ply in range(1, depth):
            layer.sort(key=lambda n: n.score, reverse=True)
            layer = layer[:beam]
            jobs = _expand_jobs(layer)
            if max_nodes > 0:
                remain = max_nodes - used
                if remain <= 0:
                    break
                jobs = jobs[:remain]
            if not jobs:
                break
            nxt = _eval_jobs(jobs, lines0, workers, pool, torch_device)
            if not nxt:
                break
            layer = nxt
            used += len(layer)

        if mc_samples > 0:
            for i, node in enumerate(layer):
                seed = 1 + i * 104729
                node.score = 0.5 * node.score + 0.5 * _mc_value(
                    node.state, lines0, max(1, int(mc_horizon)), int(mc_samples), seed
                )

        layer.sort(key=lambda n: n.score, reverse=True)
        return layer[0].first_plan
    finally:
        if own_pool and pool is not None:
            pool.shutdown(wait=True)
