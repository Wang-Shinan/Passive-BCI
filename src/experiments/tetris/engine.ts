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
  /** Line-clear / independent-fall animation; blocks input & piece gravity while set. */
  anim: BoardAnim | null
}

export type FallingCell = {
  c: number
  fromR: number
  toR: number
  color: number
}

export type BoardAnim =
  | {
      kind: 'clear'
      rows: number[]
      /** Board with locked piece still showing (including full rows). */
      board: Cell[][]
      elapsed: number
      duration: number
      /** Lines cleared in this cascade step. */
      stepCleared: number
      /** Cumulative lines cleared across the whole cascade so far (incl. this step). */
      totalCleared: number
      /** Cumulative score across the whole cascade so far (incl. this step). */
      totalScoreGain: number
      /** 1-based cascade chain index. */
      chainIndex: number
    }
  | {
      kind: 'fall'
      /** Each cell falls independently (may have different distances). */
      movers: FallingCell[]
      staticCells: FallingCell[]
      finalBoard: Cell[][]
      maxDrop: number
      elapsed: number
      duration: number
      stepCleared: number
      totalCleared: number
      totalScoreGain: number
      chainIndex: number
    }

export type GameEvent =
  | { type: 'spawn'; piece: PieceType }
  | {
      type: 'lock'
      linesCleared: number
      scoreGain: number
      chains: number
    }
  | { type: 'clear_anim'; rows: number[]; linesCleared: number; chainIndex: number }
  | { type: 'fall_anim'; linesCleared: number; chainIndex: number }
  | { type: 'topout' }
  | { type: 'hardDrop'; distance: number }

export const CLEAR_ANIM_MS = 320
/** Base fall duration; scaled by how far the farthest cell drops. */
export const FALL_ANIM_MS = 220
export const FALL_ANIM_PER_CELL_MS = 55

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
    anim: null,
  }
}

export function collides(board: Cell[][], piece: Piece, ox = 0, oy = 0, matrix = piece.matrix): boolean {
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

function findFullRows(board: Cell[][]): number[] {
  const rows: number[] = []
  for (let r = 0; r < ROWS; r++) {
    if (board[r]!.every((c) => c !== 0)) rows.push(r)
  }
  return rows
}

/** Blank out cleared rows; other cells stay put (gaps open for independent fall). */
function blankClearedRows(board: Cell[][], clearedRows: number[]): Cell[][] {
  const cleared = new Set(clearedRows)
  return board.map((row, r) => (cleared.has(r) ? (Array(COLS).fill(0) as Cell[]) : [...row]))
}

/**
 * Independent per-column gravity: each block falls down into empty cells below it.
 * Blocks in different columns (and stacked ones) move independently.
 */
export function planIndependentFall(
  boardAfterBlank: Cell[][],
): { movers: FallingCell[]; staticCells: FallingCell[]; finalBoard: Cell[][]; maxDrop: number } {
  const finalBoard = emptyBoard()
  const movers: FallingCell[] = []
  const staticCells: FallingCell[] = []
  let maxDrop = 0

  for (let c = 0; c < COLS; c++) {
    // Collect blocks from bottom to top so stacking order is preserved
    const stack: { fromR: number; color: number }[] = []
    for (let r = ROWS - 1; r >= 0; r--) {
      const color = boardAfterBlank[r]![c]!
      if (color) stack.push({ fromR: r, color })
    }
    // Place from bottom upward
    for (let i = 0; i < stack.length; i++) {
      const toR = ROWS - 1 - i
      const { fromR, color } = stack[i]!
      finalBoard[toR]![c] = color
      const drop = toR - fromR
      maxDrop = Math.max(maxDrop, drop)
      const cell = { c, fromR, toR, color }
      if (drop > 0) movers.push(cell)
      else staticCells.push(cell)
    }
  }

  return { movers, staticCells, finalBoard, maxDrop }
}

const LINE_SCORES = [0, 100, 300, 500, 800]

function lineClearScore(cleared: number, level: number, chainIndex: number): number {
  const base = (LINE_SCORES[Math.min(cleared, 4)] ?? LINE_SCORES[4])!
  return base * Math.max(1, level) * chainIndex
}

function fallDurationMs(maxDrop: number): number {
  return FALL_ANIM_MS + Math.max(0, maxDrop - 1) * FALL_ANIM_PER_CELL_MS
}

function startClearAnim(
  state: GameState,
  board: Cell[][],
  fullRows: number[],
  chainIndex: number,
  prevTotalCleared: number,
  prevTotalScore: number,
): StepResult {
  const stepCleared = fullRows.length
  const stepScore = lineClearScore(stepCleared, state.level, chainIndex)
  return {
    state: {
      ...state,
      board,
      piece: null,
      lockTimer: 0,
      anim: {
        kind: 'clear',
        rows: fullRows,
        board,
        elapsed: 0,
        duration: CLEAR_ANIM_MS,
        stepCleared,
        totalCleared: prevTotalCleared + stepCleared,
        totalScoreGain: prevTotalScore + stepScore,
        chainIndex,
      },
    },
    events: [
      {
        type: 'clear_anim',
        rows: fullRows,
        linesCleared: stepCleared,
        chainIndex,
      },
    ],
  }
}

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
  if (!state.piece || state.gameOver || state.paused || state.anim) return { state, events: [] }
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
  if (!state.piece || state.gameOver || state.paused || state.anim) return { state, events: [] }
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
  if (!state.piece || state.gameOver || state.paused || state.anim) return { state, events: [] }
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
      fy: piece.fy,
    }
    if (!collides(state.board, test)) {
      return { state: { ...state, piece: test, lockTimer: 0 }, events: [] }
    }
  }
  return { state, events: [] }
}

function finishLockSpawn(
  state: GameState,
  board: Cell[][],
  linesCleared: number,
  scoreGain: number,
  chains: number,
  rng: () => number,
): StepResult {
  const lines = state.lines + linesCleared
  const level = Math.floor(lines / 10) + 1
  const score = state.score + scoreGain
  const pulled = pullNext({ ...state, bag: state.bag, next: state.next }, rng)
  const lockEvent = {
    type: 'lock' as const,
    linesCleared,
    scoreGain,
    chains,
  }

  if (collides(board, pulled.piece)) {
    return {
      state: {
        ...state,
        board,
        piece: null,
        score,
        lines,
        level,
        gameOver: true,
        lockTimer: 0,
        anim: null,
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
      score,
      lines,
      level,
      lockTimer: 0,
      anim: null,
    },
    events: [lockEvent, { type: 'spawn', piece: pulled.piece.type }],
  }
}

function lockPiece(state: GameState, rng: () => number): StepResult {
  if (!state.piece) return { state, events: [] }
  const merged = merge(state.board, state.piece)
  const fullRows = findFullRows(merged)

  if (fullRows.length === 0) {
    return finishLockSpawn(state, merged, 0, 0, 0, rng)
  }

  return startClearAnim(state, merged, fullRows, 1, 0, 0)
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

/**
 * Advance clear / independent-fall board animation.
 * After fall settles, newly formed full rows trigger another clear (chain).
 */
export function advanceBoardAnim(
  state: GameState,
  rng: () => number,
  dtMs: number,
): StepResult {
  if (!state.anim || state.paused) return { state, events: [] }

  const anim = state.anim
  const elapsed = anim.elapsed + dtMs

  if (anim.kind === 'clear') {
    if (elapsed < anim.duration) {
      return {
        state: { ...state, anim: { ...anim, elapsed } },
        events: [],
      }
    }

    const blanked = blankClearedRows(anim.board, anim.rows)
    const { movers, staticCells, finalBoard, maxDrop } = planIndependentFall(blanked)

    if (movers.length === 0) {
      // No movement — check for further clears on the blanked/compact board
      const more = findFullRows(finalBoard)
      if (more.length > 0) {
        return startClearAnim(
          { ...state, board: finalBoard },
          finalBoard,
          more,
          anim.chainIndex + 1,
          anim.totalCleared,
          anim.totalScoreGain,
        )
      }
      return finishLockSpawn(
        state,
        finalBoard,
        anim.totalCleared,
        anim.totalScoreGain,
        anim.chainIndex,
        rng,
      )
    }

    return {
      state: {
        ...state,
        board: finalBoard,
        anim: {
          kind: 'fall',
          movers,
          staticCells,
          finalBoard,
          maxDrop,
          elapsed: 0,
          duration: fallDurationMs(maxDrop),
          stepCleared: anim.stepCleared,
          totalCleared: anim.totalCleared,
          totalScoreGain: anim.totalScoreGain,
          chainIndex: anim.chainIndex,
        },
      },
      events: [
        {
          type: 'fall_anim',
          linesCleared: anim.stepCleared,
          chainIndex: anim.chainIndex,
        },
      ],
    }
  }

  // fall in progress
  if (elapsed < anim.duration) {
    return {
      state: { ...state, anim: { ...anim, elapsed } },
      events: [],
    }
  }

  // Fall done — chain if new full rows formed
  const more = findFullRows(anim.finalBoard)
  if (more.length > 0) {
    return startClearAnim(
      { ...state, board: anim.finalBoard },
      anim.finalBoard,
      more,
      anim.chainIndex + 1,
      anim.totalCleared,
      anim.totalScoreGain,
    )
  }

  return finishLockSpawn(
    state,
    anim.finalBoard,
    anim.totalCleared,
    anim.totalScoreGain,
    anim.chainIndex,
    rng,
  )
}

export function animProgress(anim: BoardAnim): number {
  return Math.min(1, anim.elapsed / anim.duration)
}

export function animEasedProgress(anim: BoardAnim): number {
  return easeOutCubic(animProgress(anim))
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
  if (!state.piece || state.gameOver || state.paused || state.anim) {
    return { state, events: [] }
  }

  let piece = state.piece
  let score = state.score

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

/**
 * Grounded pieces wait `lockDelayMs` before locking. Moves/rotates already
 * reset `lockTimer`. Used by follow-mode so a teacher slide onto the stack
 * does not freeze the human out on the next frame.
 */
export function holdOrLock(
  state: GameState,
  rng: () => number,
  dtMs: number,
  lockDelayMs: number,
): StepResult {
  if (!state.piece || state.gameOver || state.paused || state.anim) {
    return { state, events: [] }
  }
  if (!collides(state.board, state.piece, 0, 1)) {
    if (state.lockTimer === 0) return { state, events: [] }
    return { state: { ...state, lockTimer: 0 }, events: [] }
  }
  const lockTimer = state.lockTimer + Math.max(0, dtMs)
  if (lockTimer >= lockDelayMs) {
    return lockPiece({ ...state, piece: { ...state.piece, fy: 0 }, lockTimer: 0 }, rng)
  }
  return { state: { ...state, lockTimer }, events: [] }
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
