"""Reward shaping for Tetris RL."""

from __future__ import annotations

from .engine import COLS, ROWS, GameState


def column_heights(board: list[list[int]]) -> list[int]:
    heights = [0] * COLS
    for c in range(COLS):
        for r in range(ROWS):
            if board[r][c]:
                heights[c] = ROWS - r
                break
    return heights


def aggregate_height(board: list[list[int]]) -> int:
    return sum(column_heights(board))


def bumpiness(board: list[list[int]]) -> int:
    heights = column_heights(board)
    return sum(abs(heights[i] - heights[i + 1]) for i in range(COLS - 1))


def holes(board: list[list[int]]) -> int:
    count = 0
    for c in range(COLS):
        blocked = False
        for r in range(ROWS):
            if board[r][c]:
                blocked = True
            elif blocked:
                count += 1
    return count


def board_features(board: list[list[int]]) -> dict[str, float]:
    heights = column_heights(board)
    return {
        "aggregate_height": float(aggregate_height(board)),
        "holes": float(holes(board)),
        "bumpiness": float(bumpiness(board)),
        "max_height": float(max(heights) if heights else 0.0),
    }


def board_potential(board: list[list[int]]) -> float:
    f = board_features(board)
    return (
        -0.51 * f["aggregate_height"]
        - 0.35 * f["holes"]
        - 0.18 * f["bumpiness"]
        - 0.08 * f["max_height"]
    )


def compute_reward(
    prev: GameState,
    nxt: GameState,
    lines_delta: int,
    survival_bonus: float = 0.05,
) -> float:
    reward = 0.0

    if lines_delta > 0:
        reward += [0.0, 12.0, 36.0, 60.0, 100.0][min(lines_delta, 4)]

    if nxt.game_over and not prev.game_over:
        reward -= 2.0

    reward += survival_bonus

    return reward
