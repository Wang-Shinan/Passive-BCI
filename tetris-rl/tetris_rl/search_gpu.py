"""Batched GPU (or CPU-torch) lock + score unit for placement BFS.

One kernel-shaped step: many (board, piece, rot, x) hard-drop in parallel.
Ply N still waits on ply N-1; bag/spawn stays on CPU for engine parity.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
import torch

from .engine import (
    COLS,
    COLOR_INDEX,
    ROWS,
    SHAPES,
    GameState,
    finish_lock_spawn,
)
from .encode import PIECE_TYPES
from .rng import mulberry32

_SENTINEL = -99
_MIN_BATCH = 8


def resolve_search_device(name: str) -> torch.device | None:
    if name in ("", "none", "python"):
        return None
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(name)


@lru_cache(maxsize=1)
def _shape_tables() -> tuple[np.ndarray, np.ndarray]:
    cells = np.full((7, 4, 4, 2), _SENTINEL, dtype=np.int64)
    colors = np.zeros(7, dtype=np.int64)
    for ti, name in enumerate(PIECE_TYPES):
        colors[ti] = COLOR_INDEX[name]
        for rot in range(4):
            k = 0
            for r, row in enumerate(SHAPES[name][rot]):
                for c, val in enumerate(row):
                    if val:
                        cells[ti, rot, k] = (r, c)
                        k += 1
    return cells, colors


def _piece_cells(types: torch.Tensor, rots: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    cells_np, colors_np = _shape_tables()
    cells = torch.as_tensor(cells_np, device=types.device)
    colors = torch.as_tensor(colors_np, device=types.device)
    return cells[types, rots], colors[types]


def _collides(
    board: torch.Tensor,
    xs: torch.Tensor,
    ys: torch.Tensor,
    cells: torch.Tensor,
) -> torch.Tensor:
    valid = cells[:, :, 0] > (_SENTINEL + 1)
    rr = ys[:, None] + cells[:, :, 0]
    cc = xs[:, None] + cells[:, :, 1]
    out = (cc < 0) | (cc >= COLS) | (rr >= ROWS)
    on = valid & (rr >= 0) & (rr < ROWS) & (cc >= 0) & (cc < COLS)
    hit = torch.zeros_like(valid)
    if on.any():
        b, k = on.nonzero(as_tuple=True)
        hit[b, k] = board[b, rr[b, k], cc[b, k]] > 0
    return ((out | hit) & valid).any(dim=1)


def _hard_drop_y(board: torch.Tensor, xs: torch.Tensor, ys: torch.Tensor, cells: torch.Tensor) -> torch.Tensor:
    y = ys.clone()
    for _ in range(ROWS + 2):
        nxt = y + 1
        blocked = _collides(board, xs, nxt, cells)
        y = torch.where(blocked, y, nxt)
    return y


def _merge(board: torch.Tensor, xs: torch.Tensor, ys: torch.Tensor, cells: torch.Tensor, colors: torch.Tensor) -> torch.Tensor:
    out = board.clone()
    valid = cells[:, :, 0] > (_SENTINEL + 1)
    rr = ys[:, None] + cells[:, :, 0]
    cc = xs[:, None] + cells[:, :, 1]
    on = valid & (rr >= 0) & (rr < ROWS) & (cc >= 0) & (cc < COLS)
    if on.any():
        b, k = on.nonzero(as_tuple=True)
        out[b, rr[b, k], cc[b, k]] = colors[b]
    return out


def _pack_columns(board: torch.Tensor, keep_row: torch.Tensor) -> torch.Tensor:
    masked = board * keep_row.unsqueeze(-1)
    occ = masked > 0
    occ_f = occ.flip(1)
    val_f = masked.flip(1)
    dest = (occ_f.cumsum(1) - 1).clamp(min=0)
    packed_f = torch.zeros_like(val_f)
    if occ_f.any():
        b, r, c = occ_f.nonzero(as_tuple=True)
        packed_f[b, dest[b, r, c], c] = val_f[b, r, c]
    return packed_f.flip(1)


def _cascade(board: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    total = torch.zeros(board.shape[0], dtype=torch.int64, device=board.device)
    for _ in range(ROWS):
        full = (board > 0).all(dim=2)
        n = full.sum(dim=1)
        if not bool((n > 0).any()):
            break
        total = total + n
        packed = _pack_columns(board, ~full)
        # Packing collapses holes. Only boards that actually cleared may pack;
        # otherwise a mixed batch would "gravity" everyone and invent extra lines.
        board = torch.where(n.view(-1, 1, 1) > 0, packed, board)
    return board, total


def _potential(board: torch.Tensor) -> torch.Tensor:
    occ = board > 0
    col_has = occ.any(dim=1)
    first = occ.float().argmax(dim=1)
    heights = torch.where(col_has, ROWS - first, torch.zeros_like(first))
    agg = heights.sum(dim=1, dtype=torch.float32)
    mx = heights.max(dim=1).values.to(torch.float32)
    bump = (heights[:, 1:] - heights[:, :-1]).abs().sum(dim=1).to(torch.float32)
    blocked = occ.cumsum(dim=1) > 0
    holes = ((~occ) & blocked).sum(dim=(1, 2)).to(torch.float32)
    return -0.51 * agg - 0.35 * holes - 0.18 * bump - 0.08 * mx


def _boards_from_states(moved: list[GameState], device: torch.device) -> tuple[torch.Tensor, ...]:
    boards = np.stack([np.asarray(s.board, dtype=np.int64) for s in moved], axis=0)
    types = np.array([PIECE_TYPES.index(s.piece.type) for s in moved], dtype=np.int64)
    rots = np.array([int(s.piece.rot) for s in moved], dtype=np.int64)
    xs = np.array([int(s.piece.x) for s in moved], dtype=np.int64)
    ys = np.array([int(s.piece.y) for s in moved], dtype=np.int64)
    return (
        torch.as_tensor(boards, device=device),
        torch.as_tensor(types, device=device),
        torch.as_tensor(rots, device=device),
        torch.as_tensor(xs, device=device),
        torch.as_tensor(ys, device=device),
    )


def _attach_spawn(moved: GameState, board: list[list[int]], lines_gain: int) -> GameState:
    locked, _, _ = finish_lock_spawn(moved, board, int(lines_gain), 0, 1, mulberry32(1))
    return locked


def lock_score_batch(
    moved: list[GameState],
    lines0: int,
    device: torch.device,
) -> tuple[list[GameState], list[float]]:
    """Parallel lock + leaf score. Spawn/bag stays on CPU for parity."""
    if not moved:
        return [], []
    boards, types, rots, xs, ys = _boards_from_states(moved, device)
    cells, colors = _piece_cells(types, rots)
    y_land = _hard_drop_y(boards, xs, ys, cells)
    merged = _merge(boards, xs, y_land, cells, colors)
    after, gained = _cascade(merged)
    lines_now = torch.tensor([s.lines for s in moved], device=device, dtype=torch.float32)
    scores = _potential(after) + 12.0 * (gained.to(torch.float32) + lines_now - float(lines0))
    boards_cpu = after.detach().cpu().tolist()
    gained_cpu = gained.detach().cpu().tolist()
    locked: list[GameState] = []
    out_scores: list[float] = []
    for src, board, gain, score in zip(moved, boards_cpu, gained_cpu, scores.detach().cpu().tolist()):
        state = _attach_spawn(src, board, int(gain))
        if state.game_over:
            score -= 50.0
        locked.append(state)
        out_scores.append(float(score if not state.game_over else score))
    return locked, out_scores


def should_use_gpu_batch(n: int, device: torch.device | None) -> bool:
    if device is None or n < _MIN_BATCH:
        return False
    if device.type == "cuda":
        return True
    return n >= 32
