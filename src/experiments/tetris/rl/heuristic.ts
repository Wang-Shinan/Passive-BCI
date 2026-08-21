/** 1-ply placement teacher used by BC. Emits DAS actions at 10 Hz. */

import { mulberry32 } from '../../../lib/rng'
import { boardFeatures } from '../boardFeatures'
import { COLS, collides, hardDrop, move, rotate, type GameState } from '../engine'
import { type RlAction } from './contracts'
import { instantResolveAnim } from './instantResolve'

const NOP_RNG = () => 0.5

function cloneState(state: GameState): GameState {
  return {
    ...state,
    board: state.board.map((row) => row.slice()),
    piece: state.piece ? { ...state.piece } : null,
    bag: [...state.bag],
  }
}

function lockCandidate(moved: GameState): GameState {
  const rng = mulberry32(1)
  const dropped = hardDrop(cloneState(moved), rng).state
  return instantResolveAnim(dropped, rng).state
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

export function simulateLock(state: GameState): GameState {
  if (!state.piece || state.gameOver || state.anim) return state
  return lockCandidate(state)
}

export function scoreLock(state: GameState, lines0: number): number {
  return leafScore(lockCandidate(state), lines0)
}

export function scoreBoard(state: GameState, lines0: number): number {
  return leafScore(state, lines0)
}

export function bestPlacementActions(state: GameState): RlAction[] {
  if (!state.piece || state.gameOver || state.anim) return []
  const startX = state.piece.x
  const best = bestPlacement(state)
  if (!best) return ['hardDrop']
  return planFor(best.rotSteps, best.x, startX)
}

export interface PlacementChoice {
  rotSteps: number
  x: number
  rot: number
  score: number
}

export function enumeratePlacements(state: GameState): PlacementChoice[] {
  if (!state.piece || state.gameOver || state.anim) return []
  const rotations = state.piece.type === 'O' ? 1 : 4
  const lines0 = state.lines
  const out: PlacementChoice[] = []
  for (let rot = 0; rot < rotations; rot++) {
    const rotated = tryRotate(state, rot)
    if (!rotated?.piece) continue
    for (let x = -4; x < COLS + 4; x++) {
      const moved = tryMoveToX(rotated, x)
      if (!moved?.piece) continue
      if (collides(moved.board, moved.piece)) continue
      const locked = lockCandidate(moved)
      out.push({
        rotSteps: rot,
        x: moved.piece.x,
        rot: moved.piece.rot,
        score: leafScore(locked, lines0),
      })
    }
  }
  return out
}

export function bestPlacement(state: GameState): PlacementChoice | null {
  const all = enumeratePlacements(state)
  if (all.length === 0) return null
  return all.reduce((best, item) => (item.score > best.score ? item : best))
}

export interface BfsLock {
  x: number
  y: number
  rot: number
  score: number
}

function poseKey(state: GameState): string {
  const p = state.piece
  if (!p) return ''
  return `${p.x}|${p.y}|${p.rot}`
}

function bfsNeighbors(state: GameState): GameState[] {
  if (!state.piece) return []
  const key = poseKey(state)
  const nextStates = [
    move(state, -1, NOP_RNG).state,
    move(state, 1, NOP_RNG).state,
    rotate(state, 1, NOP_RNG).state,
    rotate(state, -1, NOP_RNG).state,
  ]
  return nextStates.filter((next) => next.piece && poseKey(next) !== key)
}

/** Interleaved left/right/rotate BFS from the live piece. Each pose hard-drops for a score. */
export function bfsLockScores(state: GameState): BfsLock[] {
  if (!state.piece || state.gameOver || state.anim) return []
  const lines0 = state.lines
  const queue: GameState[] = [cloneState(state)]
  const seen = new Set([poseKey(state)])
  const out: BfsLock[] = []

  while (queue.length > 0) {
    const cur = queue.shift()!
    if (!cur.piece) continue
    const locked = lockCandidate(cur)
    out.push({
      x: cur.piece.x,
      y: cur.piece.y,
      rot: cur.piece.rot,
      score: leafScore(locked, lines0),
    })
    for (const next of bfsNeighbors(cur)) {
      const key = poseKey(next)
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(next)
    }
  }
  return out
}

export function peakScoreByRotation(locks: BfsLock[]): Map<number, number> {
  const peaks = new Map<number, number>()
  for (const lock of locks) {
    const prev = peaks.get(lock.rot)
    if (prev == null || lock.score > prev) peaks.set(lock.rot, lock.score)
  }
  return peaks
}

export function shorterRotateAction(from: number, to: number): RlAction {
  const cw = (to - from + 4) % 4
  const ccw = (from - to + 4) % 4
  if (ccw > 0 && ccw < cw) return 'rotateCCW'
  return 'rotateCW'
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
