"""Tetris engine port — mirrors src/experiments/tetris/engine.ts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .rng import mulberry32, shuffle_in_place

COLS = 10
ROWS = 20

PieceType = Literal["I", "O", "T", "S", "Z", "J", "L"]
BAG_ORDER: list[PieceType] = ["I", "O", "T", "S", "Z", "J", "L"]

COLOR_INDEX: dict[PieceType, int] = {
    "I": 1,
    "O": 2,
    "T": 3,
    "S": 4,
    "Z": 5,
    "J": 6,
    "L": 7,
}

SHAPES: dict[PieceType, list[list[list[int]]]] = {
    "I": [
        [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
        [[0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0]],
        [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]],
        [[0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0]],
    ],
    "O": [[[1, 1], [1, 1]]] * 4,
    "T": [
        [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
        [[0, 1, 0], [0, 1, 1], [0, 1, 0]],
        [[0, 0, 0], [1, 1, 1], [0, 1, 0]],
        [[0, 1, 0], [1, 1, 0], [0, 1, 0]],
    ],
    "S": [
        [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
        [[0, 1, 0], [0, 1, 1], [0, 0, 1]],
        [[0, 0, 0], [0, 1, 1], [1, 1, 0]],
        [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
    ],
    "Z": [
        [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
        [[0, 0, 1], [0, 1, 1], [0, 1, 0]],
        [[0, 0, 0], [1, 1, 0], [0, 1, 1]],
        [[0, 1, 0], [1, 1, 0], [1, 0, 0]],
    ],
    "J": [
        [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
        [[0, 1, 1], [0, 1, 0], [0, 1, 0]],
        [[0, 0, 0], [1, 1, 1], [0, 0, 1]],
        [[0, 1, 0], [0, 1, 0], [1, 1, 0]],
    ],
    "L": [
        [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
        [[0, 1, 0], [0, 1, 0], [0, 1, 1]],
        [[0, 0, 0], [1, 1, 1], [1, 0, 0]],
        [[1, 1, 0], [0, 1, 0], [0, 1, 0]],
    ],
}

JLSTZ_KICKS = [
    [(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)],
    [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)],
    [(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)],
    [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)],
]

I_KICKS = [
    [(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)],
    [(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)],
    [(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)],
    [(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)],
]

LINE_SCORES = [0, 100, 300, 500, 800]
CLEAR_ANIM_MS = 320
FALL_ANIM_MS = 220
FALL_ANIM_PER_CELL_MS = 55


@dataclass
class Piece:
    type: PieceType
    rot: int
    x: int
    y: int
    fy: float
    matrix: list[list[int]]


@dataclass
class ClearAnim:
    kind: Literal["clear"] = "clear"
    rows: list[int] = field(default_factory=list)
    board: list[list[int]] = field(default_factory=list)
    elapsed: float = 0.0
    duration: float = CLEAR_ANIM_MS
    step_cleared: int = 0
    total_cleared: int = 0
    total_score_gain: int = 0
    chain_index: int = 1


@dataclass
class FallAnim:
    kind: Literal["fall"] = "fall"
    movers: list[dict] = field(default_factory=list)
    static_cells: list[dict] = field(default_factory=list)
    final_board: list[list[int]] = field(default_factory=list)
    max_drop: int = 0
    elapsed: float = 0.0
    duration: float = FALL_ANIM_MS
    step_cleared: int = 0
    total_cleared: int = 0
    total_score_gain: int = 0
    chain_index: int = 1


BoardAnim = ClearAnim | FallAnim


@dataclass
class GameState:
    board: list[list[int]]
    piece: Piece | None
    next: PieceType
    bag: list[PieceType]
    score: int = 0
    lines: int = 0
    level: int = 1
    game_over: bool = False
    paused: bool = False
    lock_timer: int = 0
    anim: BoardAnim | None = None


def empty_board() -> list[list[int]]:
    return [[0] * COLS for _ in range(ROWS)]


def refill_bag(rng) -> list[PieceType]:
    return shuffle_in_place(BAG_ORDER.copy(), rng)


def spawn_piece(piece_type: PieceType) -> Piece:
    matrix = [row[:] for row in SHAPES[piece_type][0]]
    x = (COLS - len(matrix[0])) // 2
    y = -1 if piece_type == "I" else 0
    return Piece(piece_type, 0, x, y, 0.0, matrix)


def create_game(seed: int = 1) -> GameState:
    rng = mulberry32(seed)
    bag = refill_bag(rng)
    first = bag.pop()
    if not bag:
        bag.extend(refill_bag(rng))
    nxt = bag.pop()
    return GameState(empty_board(), spawn_piece(first), nxt, bag)


def collides(
    board: list[list[int]],
    piece: Piece,
    ox: int = 0,
    oy: int = 0,
    matrix: list[list[int]] | None = None,
) -> bool:
    matrix = matrix if matrix is not None else piece.matrix
    for r, row in enumerate(matrix):
        for c, val in enumerate(row):
            if not val:
                continue
            x = piece.x + c + ox
            y = piece.y + r + oy
            if x < 0 or x >= COLS or y >= ROWS:
                return True
            if y >= 0 and board[y][x]:
                return True
    return False


def merge(board: list[list[int]], piece: Piece) -> list[list[int]]:
    nxt = [row[:] for row in board]
    color = COLOR_INDEX[piece.type]
    for r, row in enumerate(piece.matrix):
        for c, val in enumerate(row):
            if not val:
                continue
            x = piece.x + c
            y = piece.y + r
            if 0 <= y < ROWS and 0 <= x < COLS:
                nxt[y][x] = color
    return nxt


def find_full_rows(board: list[list[int]]) -> list[int]:
    return [r for r in range(ROWS) if all(board[r])]


def blank_cleared_rows(board: list[list[int]], cleared_rows: list[int]) -> list[list[int]]:
    cleared = set(cleared_rows)
    return [[0] * COLS if r in cleared else row[:] for r, row in enumerate(board)]


def plan_independent_fall(board_after_blank: list[list[int]]):
    final_board = empty_board()
    movers: list[dict] = []
    static_cells: list[dict] = []
    max_drop = 0

    for c in range(COLS):
        stack: list[tuple[int, int]] = []
        for r in range(ROWS - 1, -1, -1):
            color = board_after_blank[r][c]
            if color:
                stack.append((r, color))
        for i, (from_r, color) in enumerate(stack):
            to_r = ROWS - 1 - i
            final_board[to_r][c] = color
            drop = to_r - from_r
            max_drop = max(max_drop, drop)
            cell = {"c": c, "fromR": from_r, "toR": to_r, "color": color}
            if drop > 0:
                movers.append(cell)
            else:
                static_cells.append(cell)

    return movers, static_cells, final_board, max_drop


def line_clear_score(cleared: int, level: int, chain_index: int) -> int:
    base = LINE_SCORES[min(cleared, 4)]
    return base * max(1, level) * chain_index


def fall_duration_ms(max_drop: int) -> float:
    return FALL_ANIM_MS + max(0, max_drop - 1) * FALL_ANIM_PER_CELL_MS


def pull_next(state: GameState, rng):
    bag = state.bag[:]
    if not bag:
        bag.extend(refill_bag(rng))
    piece_type = state.next
    nxt = bag.pop()
    if not bag:
        bag.extend(refill_bag(rng))
    return spawn_piece(piece_type), nxt, bag


def start_clear_anim(
    state: GameState,
    board: list[list[int]],
    full_rows: list[int],
    chain_index: int,
    prev_total_cleared: int,
    prev_total_score: int,
):
    step_cleared = len(full_rows)
    step_score = line_clear_score(step_cleared, state.level, chain_index)
    anim = ClearAnim(
        rows=full_rows[:],
        board=[row[:] for row in board],
        elapsed=0.0,
        duration=CLEAR_ANIM_MS,
        step_cleared=step_cleared,
        total_cleared=prev_total_cleared + step_cleared,
        total_score_gain=prev_total_score + step_score,
        chain_index=chain_index,
    )
    new_state = GameState(
        board=[row[:] for row in board],
        piece=None,
        next=state.next,
        bag=state.bag[:],
        score=state.score,
        lines=state.lines,
        level=state.level,
        game_over=state.game_over,
        paused=state.paused,
        lock_timer=0,
        anim=anim,
    )
    return new_state, []


def finish_lock_spawn(
    state: GameState,
    board: list[list[int]],
    lines_cleared: int,
    score_gain: int,
    chains: int,
    rng,
):
    lines = state.lines + lines_cleared
    level = lines // 10 + 1
    score = state.score + score_gain
    piece, nxt, bag = pull_next(state, rng)

    if collides(board, piece):
        return GameState(
            board=[row[:] for row in board],
            piece=None,
            next=state.next,
            bag=state.bag[:],
            score=score,
            lines=lines,
            level=level,
            game_over=True,
            paused=state.paused,
            lock_timer=0,
            anim=None,
        ), lines_cleared, score_gain

    return GameState(
        board=[row[:] for row in board],
        piece=piece,
        next=nxt,
        bag=bag,
        score=score,
        lines=lines,
        level=level,
        game_over=False,
        paused=state.paused,
        lock_timer=0,
        anim=None,
    ), lines_cleared, score_gain


def lock_piece(state: GameState, rng):
    if not state.piece:
        return state, 0, 0
    merged = merge(state.board, state.piece)
    full_rows = find_full_rows(merged)
    if not full_rows:
        new_state, lc, sg = finish_lock_spawn(state, merged, 0, 0, 0, rng)
        return new_state, lc, sg
    new_state, _ = start_clear_anim(state, merged, full_rows, 1, 0, 0)
    return new_state, 0, 0


def advance_board_anim(state: GameState, rng, dt_ms: float):
    if not state.anim or state.paused:
        return state, 0, 0

    anim = state.anim
    elapsed = anim.elapsed + dt_ms

    if isinstance(anim, ClearAnim):
        if elapsed < anim.duration:
            anim.elapsed = elapsed
            state.anim = anim
            return state, 0, 0

        blanked = blank_cleared_rows(anim.board, anim.rows)
        movers, static_cells, final_board, max_drop = plan_independent_fall(blanked)

        if not movers:
            more = find_full_rows(final_board)
            if more:
                new_state, _ = start_clear_anim(
                    GameState(
                        board=final_board,
                        piece=state.piece,
                        next=state.next,
                        bag=state.bag[:],
                        score=state.score,
                        lines=state.lines,
                        level=state.level,
                        game_over=state.game_over,
                        paused=state.paused,
                        anim=None,
                    ),
                    final_board,
                    more,
                    anim.chain_index + 1,
                    anim.total_cleared,
                    anim.total_score_gain,
                )
                return new_state, anim.total_cleared, anim.total_score_gain

            new_state, lc, sg = finish_lock_spawn(
                state,
                final_board,
                anim.total_cleared,
                anim.total_score_gain,
                anim.chain_index,
                rng,
            )
            return new_state, lc, sg

        fall_anim = FallAnim(
            movers=movers,
            static_cells=static_cells,
            final_board=final_board,
            max_drop=max_drop,
            elapsed=0.0,
            duration=fall_duration_ms(max_drop),
            step_cleared=anim.step_cleared,
            total_cleared=anim.total_cleared,
            total_score_gain=anim.total_score_gain,
            chain_index=anim.chain_index,
        )
        state.board = final_board
        state.anim = fall_anim
        return state, 0, 0

    # fall anim
    if elapsed < anim.duration:
        anim.elapsed = elapsed
        state.anim = anim
        return state, 0, 0

    more = find_full_rows(anim.final_board)
    if more:
        new_state, _ = start_clear_anim(
            GameState(
                board=anim.final_board,
                piece=state.piece,
                next=state.next,
                bag=state.bag[:],
                score=state.score,
                lines=state.lines,
                level=state.level,
                game_over=state.game_over,
                paused=state.paused,
                anim=None,
            ),
            anim.final_board,
            more,
            anim.chain_index + 1,
            anim.total_cleared,
            anim.total_score_gain,
        )
        return new_state, 0, 0

    new_state, lc, sg = finish_lock_spawn(
        state,
        anim.final_board,
        anim.total_cleared,
        anim.total_score_gain,
        anim.chain_index,
        rng,
    )
    return new_state, lc, sg


def instant_resolve_anim(state: GameState, rng) -> GameState:
    guard = 0
    while state.anim and guard < 64:
        guard += 1
        remaining = max(1.0, state.anim.duration - state.anim.elapsed)
        state, _, _ = advance_board_anim(state, rng, remaining)
    return state


def move(state: GameState, dx: int) -> GameState:
    if not state.piece or state.game_over or state.paused or state.anim:
        return state
    if not collides(state.board, state.piece, dx, 0):
        p = state.piece
        state.piece = Piece(p.type, p.rot, p.x + dx, p.y, p.fy, [r[:] for r in p.matrix])
        state.lock_timer = 0
    return state


def rotate(state: GameState, direction: int) -> GameState:
    if not state.piece or state.game_over or state.paused or state.anim:
        return state
    piece = state.piece
    if piece.type == "O":
        return state

    from_rot = piece.rot
    to_rot = (from_rot + direction + 4) % 4
    matrix = [row[:] for row in SHAPES[piece.type][to_rot]]
    kicks = I_KICKS if piece.type == "I" else JLSTZ_KICKS
    kick_index = from_rot if direction == 1 else to_rot
    table = kicks[kick_index]

    for kx, ky in table:
        ox = kx if direction == 1 else -kx
        oy = ky if direction == 1 else -ky
        test = Piece(piece.type, to_rot, piece.x + ox, piece.y - oy, 0.0, matrix)
        if not collides(state.board, test):
            state.piece = test
            state.lock_timer = 0
            break
    return state


def hard_drop(state: GameState, rng) -> GameState:
    if not state.piece or state.game_over or state.paused or state.anim:
        return state
    dist = 0
    while state.piece and not collides(state.board, state.piece, 0, 1):
        p = state.piece
        state.piece = Piece(p.type, p.rot, p.x, p.y + 1, 0.0, [r[:] for r in p.matrix])
        state.score += 2
        dist += 1
    if state.piece:
        p = state.piece
        state.piece = Piece(p.type, p.rot, p.x, p.y, 0.0, [r[:] for r in p.matrix])
    state, _, _ = lock_piece(state, rng)
    return state


def advance_fall(
    state: GameState,
    rng,
    dt_sec: float,
    cells_per_sec: float,
    scoring: bool = False,
) -> GameState:
    if not state.piece or state.game_over or state.paused or state.anim:
        return state

    piece = state.piece
    score = state.score

    if collides(state.board, piece, 0, 1):
        state, _, _ = lock_piece(
            GameState(
                board=state.board,
                piece=Piece(piece.type, piece.rot, piece.x, piece.y, 0.0, [r[:] for r in piece.matrix]),
                next=state.next,
                bag=state.bag[:],
                score=score,
                lines=state.lines,
                level=state.level,
                game_over=state.game_over,
                paused=state.paused,
                anim=state.anim,
            ),
            rng,
        )
        return state

    fy = piece.fy + max(0.0, cells_per_sec) * max(0.0, dt_sec)
    steps = 0
    piece = state.piece

    while fy >= 1.0 and steps < 8:
        if collides(state.board, piece, 0, 1):
            state.piece = Piece(piece.type, piece.rot, piece.x, piece.y, 0.0, [r[:] for r in piece.matrix])
            state.score = score
            state, _, _ = lock_piece(state, rng)
            return state
        piece = Piece(piece.type, piece.rot, piece.x, piece.y + 1, piece.fy, [r[:] for r in piece.matrix])
        fy -= 1.0
        steps += 1
        if scoring:
            score += 1

    if collides(state.board, piece, 0, 1):
        state.piece = Piece(piece.type, piece.rot, piece.x, piece.y, 0.0, [r[:] for r in piece.matrix])
        state.score = score
        state, _, _ = lock_piece(state, rng)
        return state

    state.score = score
    state.piece = Piece(piece.type, piece.rot, piece.x, piece.y, fy, [r[:] for r in piece.matrix])
    state.lock_timer = 0
    return state


def soft_drop_burst(state: GameState, rng, dt_sec: float, boost: float = 24.0) -> GameState:
    return advance_fall(state, rng, dt_sec, boost, True)


def copy_game_state(state: GameState) -> GameState:
    piece = None
    if state.piece:
        p = state.piece
        piece = Piece(p.type, p.rot, p.x, p.y, p.fy, [row[:] for row in p.matrix])
    anim = state.anim
    if isinstance(anim, ClearAnim):
        anim = ClearAnim(
            rows=anim.rows[:],
            board=[row[:] for row in anim.board],
            elapsed=anim.elapsed,
            duration=anim.duration,
            step_cleared=anim.step_cleared,
            total_cleared=anim.total_cleared,
            total_score_gain=anim.total_score_gain,
            chain_index=anim.chain_index,
        )
    elif isinstance(anim, FallAnim):
        anim = FallAnim(
            movers=[dict(m) for m in anim.movers],
            static_cells=[dict(m) for m in anim.static_cells],
            final_board=[row[:] for row in anim.final_board],
            max_drop=anim.max_drop,
            elapsed=anim.elapsed,
            duration=anim.duration,
            step_cleared=anim.step_cleared,
            total_cleared=anim.total_cleared,
            total_score_gain=anim.total_score_gain,
            chain_index=anim.chain_index,
        )
    return GameState(
        board=[row[:] for row in state.board],
        piece=piece,
        next=state.next,
        bag=state.bag[:],
        score=state.score,
        lines=state.lines,
        level=state.level,
        game_over=state.game_over,
        paused=state.paused,
        lock_timer=state.lock_timer,
        anim=anim,
    )


RL_ACTION_NAMES = [
    "noop",
    "left",
    "right",
    "rotateCW",
    "rotateCCW",
    "softDrop",
    "hardDrop",
]

RL_DECISION_DT_SEC = 0.1
RL_SOFT_DROP_CELLS_PER_SEC = 22.0


def apply_rl_action(state: GameState, action: str) -> GameState:
    if state.game_over or state.paused or state.anim:
        return state
    if action == "left":
        return move(state, -1)
    if action == "right":
        return move(state, 1)
    if action == "rotateCW":
        return rotate(state, 1)
    if action == "rotateCCW":
        return rotate(state, -1)
    if action == "hardDrop":
        return state  # handled separately with rng
    return state


def rl_step(
    state: GameState,
    action: str,
    rng,
    cells_per_sec: float,
    dt_sec: float = RL_DECISION_DT_SEC,
    instant_anim: bool = True,
) -> GameState:
    if not state.game_over and not state.paused and not state.anim:
        if action == "hardDrop":
            state = hard_drop(state, rng)
        else:
            state = apply_rl_action(state, action)

    if state.game_over or state.paused:
        return state

    if state.anim:
        if instant_anim:
            state = instant_resolve_anim(state, rng)
        else:
            return state

    if state.game_over or state.paused or state.anim:
        return state

    if state.piece:
        speed = (
            max(cells_per_sec, RL_SOFT_DROP_CELLS_PER_SEC)
            if action == "softDrop"
            else cells_per_sec
        )
        if action == "softDrop":
            state = soft_drop_burst(state, rng, dt_sec, speed)
        else:
            state = advance_fall(state, rng, dt_sec, speed, action == "softDrop")

    if instant_anim and state.anim:
        state = instant_resolve_anim(state, rng)

    return state


def board_fingerprint(state: GameState) -> str:
    parts = ["".join(str(c) for c in row) for row in state.board]
    if state.piece:
        p = state.piece
        parts.append(f"P:{p.type},{p.rot},{p.x},{p.y},{p.fy:.3f}")
    else:
        parts.append("P:null")
    parts.append(f"N:{state.next}")
    parts.append(f"S:{state.score},L:{state.lines},GO:{1 if state.game_over else 0}")
    return "|".join(parts)
