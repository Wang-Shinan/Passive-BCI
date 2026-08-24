import { COLS, ROWS, type GameState, type PieceType } from './engine'

export interface BoardFeatures {
  holes: number
  aggregateHeight: number
  bumpiness: number
  maxHeight: number
  wells: number
}

export type TetrisControlSource = 'human' | 'mi' | 'rl' | 'teacher' | 'collab' | 'follow'

export interface TetrisContextSnapshot extends BoardFeatures {
  score: number
  lines: number
  level: number
  piece: PieceType | null
  next: PieceType
  rot: number | null
  x: number | null
  y: number | null
  fy: number | null
  gravity: number
  gravityMode: string
  stress: number
  softDrop: boolean
  control: TetrisControlSource
  paused: boolean
  gameOver: boolean
}

/** Column heights from the bottom, ignoring the falling piece. */
export function columnHeights(board: number[][]): number[] {
  const heights = Array.from({ length: COLS }, () => 0)
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (board[r]![c]) {
        heights[c] = ROWS - r
        break
      }
    }
  }
  return heights
}

export function boardFeatures(board: number[][]): BoardFeatures {
  const heights = columnHeights(board)
  let holes = 0
  let aggregateHeight = 0
  let maxHeight = 0
  for (let c = 0; c < COLS; c++) {
    const h = heights[c]!
    aggregateHeight += h
    if (h > maxHeight) maxHeight = h
    const top = ROWS - h
    for (let r = top + 1; r < ROWS; r++) {
      if (!board[r]![c]) holes++
    }
  }
  let bumpiness = 0
  for (let c = 0; c < COLS - 1; c++) {
    bumpiness += Math.abs(heights[c]! - heights[c + 1]!)
  }
  let wells = 0
  for (let c = 0; c < COLS; c++) {
    const left = c === 0 ? ROWS : heights[c - 1]!
    const right = c === COLS - 1 ? ROWS : heights[c + 1]!
    const wall = Math.min(left, right)
    if (wall > heights[c]!) wells += wall - heights[c]!
  }
  return { holes, aggregateHeight, bumpiness, maxHeight, wells }
}

export function tetrisContextSnapshot(opts: {
  state: GameState
  gravity: number
  gravityMode: string
  stress: number
  softDrop: boolean
  control: TetrisControlSource
}): TetrisContextSnapshot {
  const { state } = opts
  const piece = state.piece
  return {
    ...boardFeatures(state.board),
    score: state.score,
    lines: state.lines,
    level: state.level,
    piece: piece?.type ?? null,
    next: state.next,
    rot: piece?.rot ?? null,
    x: piece?.x ?? null,
    y: piece?.y ?? null,
    fy: piece ? Math.round(piece.fy * 1000) / 1000 : null,
    gravity: Math.round(opts.gravity * 1000) / 1000,
    gravityMode: opts.gravityMode,
    stress: Math.round(opts.stress * 100) / 100,
    softDrop: opts.softDrop,
    control: opts.control,
    paused: state.paused,
    gameOver: state.gameOver,
  }
}
