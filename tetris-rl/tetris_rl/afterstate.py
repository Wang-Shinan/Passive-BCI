"""Placement afterstates: Dellacherie-style features + DAS plan."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS, encode_observation
from .engine import COLS, ROWS, RL_ACTION_NAMES, GameState, copy_game_state
from .reward import bumpiness, column_heights, holes
from .rng import mulberry32
from .search import iter_candidates, leaf_score, lock_candidate

FEATURE_NAMES = (
    "aggregate_height",
    "holes",
    "bumpiness",
    "max_height",
    "lines_cleared",
    "game_over",
    "landing_height",
    "wells",
    "row_transitions",
)
AFTERSTATE_DIM = len(FEATURE_NAMES)
MAX_CANDIDATES = 64


def row_transitions(board: list[list[int]]) -> int:
    total = 0
    for r in range(ROWS):
        prev = 1
        for c in range(COLS):
            cur = 1 if board[r][c] else 0
            total += int(prev != cur)
            prev = cur
        total += int(prev != 1)
    return total


def wells(heights: list[int]) -> int:
    total = 0
    for c in range(COLS):
        left = heights[c - 1] if c > 0 else ROWS
        right = heights[c + 1] if c + 1 < COLS else ROWS
        drop = min(left, right) - heights[c]
        if drop > 0:
            total += drop
    return total


def landing_height(prev_board: list[list[int]], locked_board: list[list[int]]) -> int:
    ph = column_heights(prev_board)
    nh = column_heights(locked_board)
    touched = [nh[c] for c in range(COLS) if nh[c] > ph[c]]
    return max(touched) if touched else 0


def afterstate_features(prev: GameState, locked: GameState) -> np.ndarray:
    board = locked.board
    heights = column_heights(board)
    feat = np.array(
        [
            sum(heights) / 200.0,
            holes(board) / 50.0,
            bumpiness(board) / 50.0,
            (max(heights) if heights else 0.0) / 20.0,
            (locked.lines - prev.lines) / 4.0,
            1.0 if locked.game_over else 0.0,
            landing_height(prev.board, board) / 20.0,
            wells(heights) / 20.0,
            row_transitions(board) / 200.0,
        ],
        dtype=np.float32,
    )
    return feat


@dataclass
class Placement:
    plan: list[str]
    features: np.ndarray
    score: float
    locked: GameState


def enumerate_placements(state: GameState) -> list[Placement]:
    out: list[Placement] = []
    for plan, moved in iter_candidates(state):
        locked = lock_candidate(moved, mulberry32(1))
        out.append(
            Placement(
                plan=plan,
                features=afterstate_features(state, locked),
                score=leaf_score(locked, state.lines),
                locked=locked,
            )
        )
    return out


def pack_placements(placements: list[Placement]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pad to MAX_CANDIDATES. Returns feats [K,F], mask [K], teacher_idx."""
    feats = np.zeros((MAX_CANDIDATES, AFTERSTATE_DIM), dtype=np.float32)
    mask = np.zeros(MAX_CANDIDATES, dtype=np.bool_)
    n = min(len(placements), MAX_CANDIDATES)
    if n == 0:
        return feats, mask, np.int64(0)
    for i in range(n):
        feats[i] = placements[i].features
        mask[i] = True
    teacher = int(np.argmax([p.score for p in placements[:n]]))
    return feats, mask, np.int64(teacher)


def pack_boards(placements: list[Placement]) -> np.ndarray:
    boards = np.zeros((MAX_CANDIDATES, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS), dtype=np.float32)
    n = min(len(placements), MAX_CANDIDATES)
    for i in range(n):
        boards[i] = encode_observation(placements[i].locked, 0.5)
    return boards


def play_plan(env, plan: list[str]) -> tuple[bool, dict, float]:
    from .reward import compute_reward

    prev = copy_game_state(env.state)
    info = {"lines": 0, "score": 0}
    names = RL_ACTION_NAMES
    done = False
    for name in plan:
        _, _, terminated, truncated, info = env.step(names.index(name))
        if terminated or truncated:
            done = True
            break
    if not done and env.state.piece and not env.state.game_over:
        _, _, terminated, truncated, info = env.step(names.index("hardDrop"))
        done = bool(terminated or truncated)
    done = done or bool(env.state.game_over)
    rew = compute_reward(prev, env.state, env.state.lines - prev.lines, survival_bonus=env.survival_bonus)
    return done, info, float(rew)
