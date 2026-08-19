/** 1-ply placement teacher used by BC. Emits DAS actions at 10 Hz. */

import { mulberry32 } from '../../../lib/rng'
import { boardFeatures } from '../boardFeatures'
import { COLS, collides, hardDrop, move, rotate, type GameState } from '../engine'
import { type RlAction } from './contracts'
import { instantResolveAnim } from './instantResolve'

const NOP_RNG = () => 0.5

function lockCandidate(moved: GameState): GameState {
  const rng = mulberry32(1)
  const dropped = hardDrop(cloneState(moved), rng).state
  return instantResolveAnim(dropped, rng).state
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    board: state.board.map((row) => row.slice()),
    piece: state.piece ? { ...state.piece } : null,
    bag: [...state.bag],
  }
}

function tryRotate(state: GameState, times: number): GameState | null {
  let s = cloneState(state)
  for (let i = 0; i < times; i++) {
    const before = s.piece?.rot
    s = rotate(s, 1, NOP_RNG).state
    if (!s.piece || s.piece.rot === before) {
      if (times > 0 && (!s.piece || s.piece.type !== 'O')) return null
    }
  }
  return s
}

function tryMoveToX(state: GameState, targetX: number): GameState | null {
  let s = cloneState(state)
  if (!s.piece) return null
  const dx = targetX > s.piece.x ? 1 : -1
  let guard = 0
  while (s.piece && s.piece.x !== targetX && guard < COLS + 4) {
    const before = s.piece.x
    s = move(s, dx, NOP_RNG).state
    if (!s.piece || s.piece.x === before) return null
    guard++
  }
  return s
}

function planFor(rot: number, x: number, startX: number): RlAction[] {
  const plan: RlAction[] = []
  for (let i = 0; i < rot; i++) plan.push('rotateCW')
  if (x > startX) {
    for (let i = 0; i < x - startX; i++) plan.push('right')
  } else {
    for (let i = 0; i < startX - x; i++) plan.push('left')
  }
  plan.push('hardDrop')
  return plan
}

function leafScore(state: GameState, lines0: number): number {
  const f = boardFeatures(state.board)
  let score =
    -0.51 * f.aggregateHeight - 0.35 * f.holes - 0.18 * f.bumpiness - 0.08 * f.maxHeight
  score += 12.0 * (state.lines - lines0)
  if (state.gameOver) score -= 50.0
  return score
}

function lockCandidate(moved: GameState): GameState {
  const dropped = hardDrop(cloneState(moved), SEARCH_RNG).state
  return instantResolveAnim(dropped, SEARCH_RNG).state
}

export function bestPlacementActions(state: GameState): RlAction[] {
  if (!state.piece || state.gameOver || state.anim) return []
  const startX = state.piece.x
  const rotations = state.piece.type === 'O' ? 1 : 4
  const lines0 = state.lines
  let bestPlan: RlAction[] = ['hardDrop']
  let bestScore = -Infinity

  for (let rot = 0; rot < rotations; rot++) {
    const rotated = tryRotate(state, rot)
    if (!rotated?.piece) continue
    for (let x = -4; x < COLS + 4; x++) {
      const moved = tryMoveToX(rotated, x)
      if (!moved?.piece) continue
      if (collides(moved.board, moved.piece)) continue
      const locked = lockCandidate(moved)
      const score = leafScore(locked, lines0)
      if (score > bestScore) {
        bestScore = score
        bestPlan = planFor(rot, x, startX)
      }
    }
  }
  return bestPlan
}

function pieceKey(state: GameState): string | null {
  const p = state.piece
  if (!p) return null
  return `${p.type}|${state.lines}|${state.next}|${state.bag.join('')}`
}

/** Same 1-ply teacher BC clones. One placement plan per piece. */
export class HeuristicPlanner {
  private plan: RlAction[] = []
  private pieceId: string | null = null

  act(state: GameState): RlAction {
    const key = pieceKey(state)
    if (key !== this.pieceId || this.plan.length === 0) {
      this.plan = bestPlacementActions(state)
      this.pieceId = key
    }
    if (this.plan.length === 0) return 'noop'
    const action = this.plan.shift()!
    if (action === 'hardDrop') {
      this.pieceId = null
      this.plan = []
    }
    return action
  }

  reset(): void {
    this.plan = []
    this.pieceId = null
  }
}
