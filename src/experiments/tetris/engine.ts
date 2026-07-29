import { mulberry32, shuffleInPlace } from '../../lib/rng'

export const COLS = 10
export const ROWS = 20

export type Cell = number // 0 empty, 1-7 piece colors
export type Matrix = number[][]

export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'

export interface Piece {
  type: PieceType
  rot: number
  x: number
  /** Integer grid row (collision / lock). */
  y: number
  /**
   * Sub-cell fall progress in [0, 1). Visual Y = y + fy.
   * Accumulates continuously for smooth gravity.
   */
  fy: number
  matrix: Matrix
}

const SHAPES: Record<PieceType, Matrix[]> = {
  I: [
    [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    [
      [0, 0, 1, 0],
      [0, 0, 1, 0],
      [0, 0, 1, 0],
      [0, 0, 1, 0],
    ],
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
    ],
    [
      [0, 1, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 0, 0],
    ],
  ],
  O: [
    [
      [1, 1],
      [1, 1],
    ],
    [
      [1, 1],
      [1, 1],
    ],
    [
      [1, 1],
      [1, 1],
    ],
    [
      [1, 1],
      [1, 1],
    ],
  ],
  T: [
    [
      [0, 1, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  ],
  S: [
    [
      [0, 1, 1],
      [1, 1, 0],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [0, 0, 1],
    ],
    [
      [0, 0, 0],
      [0, 1, 1],
      [1, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  ],
  Z: [
    [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 1],
    ],
    [
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  ],
  J: [
    [
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 1, 1],
      [0, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 0, 1],
    ],
    [
      [0, 1, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
  ],
  L: [
    [
      [0, 0, 1],
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [1, 0, 0],
    ],
    [
      [1, 1, 0],
      [0, 1, 0],
      [0, 1, 0],
    ],
  ],
}

export const COLOR_INDEX: Record<PieceType, number> = {
  I: 1,
  O: 2,
  T: 3,
  S: 4,
  Z: 5,
  J: 6,
  L: 7,
}

export const COLORS = [
  'transparent',
  '#00f0f0', // I
  '#f0f000', // O
  '#a000f0', // T
  '#00f000', // S
  '#f00000', // Z
  '#0000f0', // J
  '#f0a000', // L
]

const BAG_ORDER: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

/** SRS kick offsets: [fromRot][kickIndex] for CW; CCW uses mirrored. */
const JLSTZ_KICKS: [number, number][][] = [
  [
    [0, 0],
    [-1, 0],
    [-1, 1],
    [0, -2],
    [-1, -2],
  ], // 0→1
  [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, 2],
    [1, 2],
  ], // 1→2
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, -2],
    [1, -2],
  ], // 2→3
  [
    [0, 0],
    [-1, 0],
    [-1, -1],
    [0, 2],
    [-1, 2],
  ], // 3→0
]

const I_KICKS: [number, number][][] = [
  [
    [0, 0],
    [-2, 0],
    [1, 0],
    [-2, -1],
    [1, 2],
  ],
  [
    [0, 0],
    [2, 0],
    [-1, 0],
    [2, 1],
    [-1, -2],
  ],
  [
    [0, 0],
    [-1, 0],
    [2, 0],
    [-1, 2],
    [2, -1],
  ],
  [
    [0, 0],
    [1, 0],
    [-2, 0],
    [1, -2],
    [-2, 1],
  ],
]

export interface CascadeStep {
  cleared: number
  rows: number[]
}

export interface GameState {
  board: Cell[][]
  piece: Piece | null
  next: PieceType
  bag: PieceType[]
  score: number
  lines: number
  level: number
  gameOver: boolean
  paused: boolean
  lockTimer: number
}

export type GameEvent =
  | { type: 'spawn'; piece: PieceType }
  | {
      type: 'lock'
      linesCleared: number
      scoreGain: number
      chains: number
      cascadeSteps: CascadeStep[]
    }
  | { type: 'topout' }
  | { type: 'hardDrop'; distance: number }

function emptyBoard(): Cell[][] {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0))
}

function refillBag(rng: () => number): PieceType[] {
  return shuffleInPlace([...BAG_ORDER], rng)
}

function spawnPiece(type: PieceType): Piece {
  const matrix = SHAPES[type][0]!
  const x = Math.floor((COLS - matrix[0]!.length) / 2)
  const y = type === 'I' ? -1 : 0
  return { type, rot: 0, x, y, fy: 0, matrix }
}

export function createGame(seed = 1): GameState {
  const rng = mulberry32(seed)
  const bag = refillBag(rng)
  const first = bag.pop()!
  if (bag.length === 0) bag.push(...refillBag(rng))
  const next = bag.pop()!
  return {
    board: emptyBoard(),
    piece: spawnPiece(first),
    next,
    bag,
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    paused: false,
    lockTimer: 0,
  }
}

function collides(board: Cell[][], piece: Piece, ox = 0, oy = 0, matrix = piece.matrix): boolean {
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r]!.length; c++) {
      if (!matrix[r]![c]) continue
      const x = piece.x + c + ox
      const y = piece.y + r + oy
      if (x < 0 || x >= COLS || y >= ROWS) return true
      if (y >= 0 && board[y]![x]) return true
    }
  }
  return false
}

function merge(board: Cell[][], piece: Piece): Cell[][] {
  const next = board.map((row) => [...row])
  const color = COLOR_INDEX[piece.type]
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r]!.length; c++) {
      if (!piece.matrix[r]![c]) continue
      const x = piece.x + c
      const y = piece.y + r
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
        next[y]![x] = color
      }
    }
  }
  return next
}

function clearFullRows(board: Cell[][]): { board: Cell[][]; cleared: number; rows: number[] } {
  const rows: number[] = []
  const next = board.map((row, r) => {
    const full = row.every((c) => c !== 0)
    if (full) {
      rows.push(r)
      return Array(COLS).fill(0) as Cell[]
    }
    return [...row]
  })
  return { board: next, cleared: rows.length, rows }
}

/** Per-column gravity: each block falls down into empty cells below. */
function applyColumnGravity(board: Cell[][]): Cell[][] {
  const next = emptyBoard()
  for (let c = 0; c < COLS; c++) {
    const stack: Cell[] = []
    for (let r = ROWS - 1; r >= 0; r--) {
      const v = board[r]![c]!
      if (v) stack.push(v)
    }
    for (let i = 0; i < stack.length; i++) {
      next[ROWS - 1 - i]![c] = stack[i]!
    }
  }
  return next
}

/**
 * Clear full rows → column gravity → repeat until stable.
 * Enables chain reactions when falling blocks form new full rows.
 */
export function cascadeClear(board: Cell[][]): {
  board: Cell[][]
  totalCleared: number
  chains: number
  steps: CascadeStep[]
} {
  let current = board.map((row) => [...row])
  let totalCleared = 0
  const steps: CascadeStep[] = []

  for (let guard = 0; guard < ROWS + 2; guard++) {
    const { board: afterClear, cleared, rows } = clearFullRows(current)
    if (cleared === 0) break
    steps.push({ cleared, rows })
    totalCleared += cleared
    current = applyColumnGravity(afterClear)
  }

  return {
    board: current,
    totalCleared,
    chains: steps.length,
    steps,
  }
}

/** Score for one cascade step; later chains get a multiplier. */
function cascadeStepScore(cleared: number, chainIndex: number, level: number): number {
  const base = LINE_SCORES[Math.min(cleared, 4)] ?? LINE_SCORES[4]!
  const chainMul = chainIndex // 1, 2, 3, ...
  return base * Math.max(1, level) * chainMul
}

const LINE_SCORES = [0, 100, 300, 500, 800]

function pullNext(state: GameState, rng: () => number): { piece: Piece; next: PieceType; bag: PieceType[] } {
  const bag = [...state.bag]
  if (bag.length === 0) bag.push(...refillBag(rng))
  const type = state.next
  const next = bag.pop()!
  if (bag.length === 0) bag.push(...refillBag(rng))
  return { piece: spawnPiece(type), next, bag }
}

export function ghostY(board: Cell[][], piece: Piece): number {
  let dy = 0
  while (!collides(board, piece, 0, dy + 1)) dy++
  return piece.y + dy
}

export interface StepResult {
  state: GameState
  events: GameEvent[]
}

export function move(state: GameState, dx: number, _rng: () => number): StepResult {
  void _rng
  if (!state.piece || state.gameOver || state.paused) return { state, events: [] }
  if (!collides(state.board, state.piece, dx, 0)) {
    return {
      state: {
        ...state,
        piece: { ...state.piece, x: state.piece.x + dx },
        lockTimer: 0,
      },
      events: [],
    }
  }
  return { state, events: [] }
}

/** Soft-drop boost: advance fall by a burst of cells/sec for one frame's worth. */
export function softDropBurst(
  state: GameState,
  rng: () => number,
  dtSec: number,
  boostCellsPerSec = 24,
): StepResult {
  return advanceFall(state, rng, dtSec, boostCellsPerSec, true)
}

export function hardDrop(state: GameState, rng: () => number): StepResult {
  if (!state.piece || state.gameOver || state.paused) return { state, events: [] }
  let dist = 0
  let s = state
  while (s.piece && !collides(s.board, s.piece, 0, 1)) {
    s = {
      ...s,
      piece: { ...s.piece, y: s.piece.y + 1, fy: 0 },
      score: s.score + 2,
    }
    dist++
  }
  const grounded = s.piece ? { ...s, piece: { ...s.piece, fy: 0 } } : s
  const locked = lockPiece(grounded, rng)
  return {
    state: locked.state,
    events: [{ type: 'hardDrop', distance: dist }, ...locked.events],
  }
}

export function rotate(state: GameState, dir: 1 | -1, _rng: () => number): StepResult {
  void _rng
  if (!state.piece || state.gameOver || state.paused) return { state, events: [] }
  const piece = state.piece
  if (piece.type === 'O') return { state, events: [] }

  const from = piece.rot
  const to = (from + dir + 4) % 4
  const matrix = SHAPES[piece.type][to]!
  const kicks = piece.type === 'I' ? I_KICKS : JLSTZ_KICKS
  const kickIndex = dir === 1 ? from : to
  const table = kicks[kickIndex]!

  for (const [kx, ky] of table) {
    // SRS: for CCW, negate kick x relative to CW table of the reverse transition
    const ox = dir === 1 ? kx : -kx
    const oy = dir === 1 ? ky : -ky
    // Note: our y grows downward, SRS y is upward — negate ky
    const test = {
      ...piece,
      rot: to,
      matrix,
      x: piece.x + ox,
      y: piece.y - oy,
      fy: 0,
    }
    if (!collides(state.board, test)) {
      return { state: { ...state, piece: test, lockTimer: 0 }, events: [] }
    }
  }
  return { state, events: [] }
}

function lockPiece(state: GameState, rng: () => number): StepResult {
  if (!state.piece) return { state, events: [] }
  const merged = merge(state.board, state.piece)
  const { board, totalCleared, chains, steps } = cascadeClear(merged)

  let scoreGain = 0
  for (let i = 0; i < steps.length; i++) {
    scoreGain += cascadeStepScore(steps[i]!.cleared, i + 1, state.level)
  }

  const lines = state.lines + totalCleared
  const level = Math.floor(lines / 10) + 1
  const pulled = pullNext({ ...state, bag: state.bag, next: state.next }, rng)

  const lockEvent = {
    type: 'lock' as const,
    linesCleared: totalCleared,
    scoreGain,
    chains,
    cascadeSteps: steps,
  }

  if (collides(board, pulled.piece)) {
    return {
      state: {
        ...state,
        board,
        piece: null,
        score: state.score + scoreGain,
        lines,
        level,
        gameOver: true,
        lockTimer: 0,
      },
      events: [lockEvent, { type: 'topout' }],
    }
  }

  return {
    state: {
      ...state,
      board,
      piece: pulled.piece,
      next: pulled.next,
      bag: pulled.bag,
      score: state.score + scoreGain,
      lines,
      level,
      lockTimer: 0,
    },
    events: [lockEvent, { type: 'spawn', piece: pulled.piece.type }],
  }
}

/**
 * Continuous gravity: advance sub-cell fall by `cellsPerSec * dtSec`.
 * When fy crosses 1, step down one grid cell; if blocked, lock.
 */
export function advanceFall(
  state: GameState,
  rng: () => number,
  dtSec: number,
  cellsPerSec: number,
  scoring = false,
): StepResult {
  if (!state.piece || state.gameOver || state.paused) return { state, events: [] }

  let piece = state.piece
  let score = state.score

  // Already resting on a surface — lock on this gravity tick
  if (collides(state.board, piece, 0, 1)) {
    return lockPiece({ ...state, piece: { ...piece, fy: 0 } }, rng)
  }

  let fy = piece.fy + Math.max(0, cellsPerSec) * Math.max(0, dtSec)
  const maxSteps = 8
  let steps = 0

  while (fy >= 1 && steps < maxSteps) {
    if (collides(state.board, piece, 0, 1)) {
      return lockPiece({ ...state, piece: { ...piece, fy: 0 }, score }, rng)
    }
    piece = { ...piece, y: piece.y + 1 }
    fy -= 1
    steps++
    if (scoring) score += 1
  }

  // Fractional settle against the floor of the next cell
  if (collides(state.board, piece, 0, 1)) {
    return lockPiece({ ...state, piece: { ...piece, fy: 0 }, score }, rng)
  }

  return {
    state: {
      ...state,
      score,
      piece: { ...piece, fy },
      lockTimer: 0,
    },
    events: [],
  }
}

/** @deprecated Use advanceFall for smooth gravity. */
export function gravityTick(state: GameState, rng: () => number): StepResult {
  return advanceFall(state, rng, 1, 1, false)
}

export function previewMatrix(type: PieceType): Matrix {
  return SHAPES[type][0]!
}

/** Visual row including sub-cell offset. */
export function visualY(piece: Piece): number {
  return piece.y + piece.fy
}
