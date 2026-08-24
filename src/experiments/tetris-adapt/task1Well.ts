import {
  COLS,
  ROWS,
  collides,
  createGame,
  ghostY,
  move,
  rotate,
  type GameState,
  type Piece,
} from '../tetris/engine'
import type { TargetDir } from '../smr-adapt/smrControl'
import type { OverlapAction } from './smrMap'

export const TASK1_GRAVITY = 0.4

export type Task1Cue = 'left' | 'right' | 'rotate' | 'drop' | 'hardDrop'

export type Task1State = {
  game: GameState
  task: 'LR' | 'UD'
  target: TargetDir
  cue: Task1Cue
  targetX: number
  targetRot: number
  targetY: number
  highlightCols: number[]
  teacher: Piece | null
}

const noopRng = () => 0.5

export function occupiedColumns(piece: Piece): number[] {
  const cols = new Set<number>()
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r]!.length; c++) {
      if (!piece.matrix[r]![c]) continue
      cols.add(piece.x + c)
    }
  }
  return [...cols].sort((a, b) => a - b)
}

export function occupiedCells(piece: { x: number; y: number; matrix: number[][] }): { c: number; r: number }[] {
  const cells: { c: number; r: number }[] = []
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r]!.length; c++) {
      if (!piece.matrix[r]![c]) continue
      cells.push({ c: piece.x + c, r: piece.y + r })
    }
  }
  return cells
}

export function extremeLegalX(board: GameState['board'], piece: Piece, dir: -1 | 1): number {
  let x = piece.x
  while (!collides(board, { ...piece, x: x + dir })) x += dir
  return x
}

export function pieceAtX(piece: Piece, x: number): Piece {
  return { ...piece, x }
}

export function landingPiece(board: GameState['board'], piece: Piece): Piece {
  return { ...piece, y: ghostY(board, piece), fy: 0 }
}

export function idleWell(seed = 1): GameState {
  const game = createGame(seed)
  return { ...game, piece: null }
}

function skipO(seed: number): GameState {
  for (let extra = 0; extra < 12; extra++) {
    const game = createGame(seed + extra * 17)
    if (game.piece && game.piece.type !== 'O') return game
  }
  return createGame(seed)
}

export function spawnTask1Trial(
  task: 'LR' | 'UD',
  target: TargetDir,
  seed: number,
): Task1State {
  const rotateCue = task === 'UD' && target === 'up'
  const dropCue = task === 'UD' && target === 'down'
  const game = rotateCue ? skipO(seed) : createGame(seed)
  const piece = game.piece
  if (!piece) {
    return {
      game,
      task,
      target,
      cue: 'left',
      targetX: 0,
      targetRot: 0,
      targetY: ROWS - 1,
      highlightCols: [],
      teacher: null,
    }
  }

  if (task === 'LR' && (target === 'left' || target === 'right')) {
    const targetX = extremeLegalX(game.board, piece, target === 'left' ? -1 : 1)
    const teacher = pieceAtX(piece, targetX)
    return {
      game,
      task,
      target,
      cue: target,
      targetX,
      targetRot: piece.rot,
      targetY: ghostY(game.board, teacher),
      highlightCols: occupiedColumns(teacher),
      teacher,
    }
  }

  if (rotateCue) {
    const rotated = rotate(game, 1, noopRng).state.piece
    const teacher = rotated && rotated.rot !== piece.rot ? rotated : piece
    return {
      game,
      task,
      target,
      cue: 'rotate',
      targetX: teacher.x,
      targetRot: teacher.rot,
      targetY: teacher.y,
      highlightCols: occupiedColumns(teacher),
      teacher,
    }
  }

  if (dropCue) {
    const teacher = landingPiece(game.board, piece)
    return {
      game,
      task,
      target,
      cue: 'drop',
      targetX: piece.x,
      targetRot: piece.rot,
      targetY: teacher.y,
      highlightCols: occupiedColumns(teacher),
      teacher,
    }
  }

  return {
    game,
    task,
    target,
    cue: 'left',
    targetX: piece.x,
    targetRot: piece.rot,
    targetY: piece.y,
    highlightCols: [],
    teacher: piece,
  }
}

export function task1Hit(state: Task1State): boolean {
  const piece = state.game.piece
  if (!piece) return false
  if (state.cue === 'left' || state.cue === 'right') return piece.x === state.targetX
  if (state.cue === 'rotate') return piece.rot === state.targetRot
  if (state.cue === 'hardDrop') return false
  return piece.y >= state.targetY
}

export function allowedTask1Action(state: Task1State, action: OverlapAction): boolean {
  if (state.cue === 'left' || state.cue === 'right') return action === 'left' || action === 'right'
  if (state.cue === 'rotate') return action === 'rotate'
  if (state.cue === 'hardDrop') return false
  return action === 'down'
}

export function snapToLanding(state: Task1State): Task1State {
  const piece = state.game.piece
  if (!piece) return state
  const landed = landingPiece(state.game.board, piece)
  return { ...state, game: { ...state.game, piece: landed } }
}

export function applyTask1Action(state: Task1State, action: OverlapAction): Task1State {
  if (!allowedTask1Action(state, action)) return state
  if (action === 'left') {
    return { ...state, game: move(state.game, -1, noopRng).state }
  }
  if (action === 'right') {
    return { ...state, game: move(state.game, 1, noopRng).state }
  }
  if (action === 'rotate') {
    return { ...state, game: rotate(state.game, 1, noopRng).state }
  }
  return snapToLanding(state)
}

export function tickTask1Gravity(state: Task1State, dtSec: number): Task1State {
  const piece = state.game.piece
  if (!piece) return state
  if (collides(state.game.board, piece, 0, 1)) {
    if (piece.fy === 0) return state
    return { ...state, game: { ...state.game, piece: { ...piece, fy: 0 } } }
  }
  let fy = piece.fy + TASK1_GRAVITY * dtSec
  let y = piece.y
  while (fy >= 1) {
    if (collides(state.game.board, { ...piece, y }, 0, 1)) {
      fy = 0
      break
    }
    y += 1
    fy -= 1
  }
  if (y === piece.y && fy === piece.fy) return state
  return { ...state, game: { ...state.game, piece: { ...piece, y, fy } } }
}

export function demoTask1Action(state: Task1State): OverlapAction | null {
  if (Math.random() < 0.18) return null
  if (task1Hit(state)) return null
  if (state.cue === 'left') return 'left'
  if (state.cue === 'right') return 'right'
  if (state.cue === 'rotate') return 'rotate'
  if (state.cue === 'hardDrop') return null
  return 'down'
}

export function spawnFeetTrial(seed: number): Task1State {
  const state = spawnTask1Trial('UD', 'down', seed)
  return { ...state, cue: 'hardDrop' }
}

export const TASK1_COLS = COLS
export const TASK1_ROWS = ROWS
