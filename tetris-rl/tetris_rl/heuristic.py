"""Greedy placement heuristic that emits realtime actions."""

from __future__ import annotations

from .engine import (
    COLS,
    collides,
    copy_game_state,
    hard_drop,
    move,
    rotate,
    GameState,
)
from .reward import board_potential
from .rng import mulberry32


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


def best_placement_actions(state: GameState, rng) -> list[str]:
    """Return a short realtime action plan for the current piece."""
    if not state.piece or state.game_over or state.anim:
        return ["noop"]

    piece = state.piece
    rotations = 1 if piece.type == "O" else 4
    best_score = float("-inf")
    best_plan: list[str] = ["hardDrop"]

    for rot in range(rotations):
        rotated = _try_rotate(state, rot)
        if rotated is None or rotated.piece is None:
            continue
        min_x = -4
        max_x = COLS + 4
        for x in range(min_x, max_x):
            moved = _try_move_to_x(rotated, x)
            if moved is None or moved.piece is None:
                continue
            if collides(moved.board, moved.piece):
                continue
            dummy_rng = mulberry32(1)
            dropped = hard_drop(copy_game_state(moved), dummy_rng)
            lines_gain = dropped.lines - state.lines
            score = board_potential(dropped.board) + 12.0 * lines_gain
            if dropped.game_over:
                score -= 50.0
            if score > best_score:
                best_score = score
                plan = (["rotateCW"] * rot) + (
                    ["right"] * max(0, x - piece.x) + ["left"] * max(0, piece.x - x)
                )
                plan.append("hardDrop")
                best_plan = plan or ["hardDrop"]

    return best_plan


class HeuristicPlanner:
    def __init__(self):
        self._plan: list[str] = []
        self._piece_id: tuple | None = None

    def _piece_key(self, state: GameState) -> tuple | None:
        p = state.piece
        if not p:
            return None
        return (p.type, p.x, p.y, p.rot, state.lines)

    def act(self, state: GameState, rng) -> int:
        from .engine import RL_ACTION_NAMES

        key = self._piece_key(state)
        if key != self._piece_id or not self._plan:
            self._plan = best_placement_actions(state, rng)
            self._piece_id = key

        if not self._plan:
            return RL_ACTION_NAMES.index("noop")
        action = self._plan.pop(0)
        if action == "hardDrop":
            self._piece_id = None
            self._plan = []
        return RL_ACTION_NAMES.index(action)
