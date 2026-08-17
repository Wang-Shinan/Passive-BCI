"""Observation encoding — mirrors src/experiments/tetris/rl/encode.ts."""

from __future__ import annotations

import numpy as np

from .engine import COLS, ROWS, GameState, PieceType

PIECE_TYPES: list[PieceType] = ["I", "O", "T", "S", "Z", "J", "L"]
RL_OBS_CHANNELS = 12
RL_OBS_ROWS = 20
RL_OBS_COLS = 10


def piece_type_index(piece_type: PieceType) -> int:
    return PIECE_TYPES.index(piece_type)


def encode_observation(state: GameState, gravity_norm: float) -> np.ndarray:
    tensor = np.zeros((RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS), dtype=np.float32)
    stride = RL_OBS_ROWS * RL_OBS_COLS

    for r in range(ROWS):
        for c in range(COLS):
            val = state.board[r][c]
            if val > 0:
                tensor[0, r, c] = val / 7.0

    if state.piece:
        piece = state.piece
        for r, row in enumerate(piece.matrix):
            for c, val in enumerate(row):
                if not val:
                    continue
                x = piece.x + c
                y = piece.y + r
                if y < 0 or y >= ROWS or x < 0 or x >= COLS:
                    continue
                tensor[1, y, x] = 1.0

        rot_norm = piece.rot / 3.0
        fy_norm = max(0.0, min(1.0, piece.fy))
        tensor[2, :, :] = rot_norm
        tensor[3, :, :] = fy_norm

    next_idx = piece_type_index(state.next)
    if next_idx >= 0:
        tensor[4 + next_idx, :, :] = 1.0

    g = max(0.0, min(1.0, gravity_norm))
    tensor[11, :, :] = g

    return tensor
