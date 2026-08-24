import { boardFeatures, columnHeights, type BoardFeatures } from './boardFeatures'
import { COLS, ROWS, collides, ghostY, rotate, type GameEvent, type GameState, type Piece } from './engine'
import type { MiControlAction } from './miControl'
import type { RlAction } from './rl/contracts'
import { bestPlacementActions, bfsLockScores, simulateLock } from './rl/heuristic'
import { applyRlAction } from './rl/step'

const STAY_EPS = 0.15
const I_WELL_MIN = 3
const ROOT_ACTIONS: RlAction[] = ['noop', 'rotateCW', 'rotateCCW']
const NOP_RNG = () => 0.5

export interface CollabSearchOptions {
  gravity?: number
  horizon?: number
}

export interface CollabDecision {
  action: RlAction
  targetRot: number | null
  expected: number | null
  lockNow: number | null
  reachable: number
}

/** Brain/SMR keeps left/right; rotate and rest are ignored in collab. */
export function executeMiInCollab(action: MiControlAction | null): MiControlAction | null {
  if (action === 'left' || action === 'right') return action
  return action == null ? null : 'none'
}

export function executeRlInCollab(action: RlAction): RlAction {
  return action === 'rotateCW' || action === 'rotateCCW' ? action : 'noop'
}

export const FOLLOW_MOVES_MIN = 1
export const FOLLOW_MOVES_MAX = 8
export const FOLLOW_MOVES_DEFAULT = 2
export const FOLLOW_STEPS_MIN = 1
export const FOLLOW_STEPS_MAX = 8
export const FOLLOW_STEPS_DEFAULT = 3
/** Grounded lock delay after teacher slides, so the human can still nudge. */
export const FOLLOW_LOCK_DELAY_MS = 800

function clampFollowBudget(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampFollowMoves(m: number): number {
  return clampFollowBudget(m, FOLLOW_MOVES_DEFAULT, FOLLOW_MOVES_MIN, FOLLOW_MOVES_MAX)
}

export function clampFollowSteps(n: number): number {
  return clampFollowBudget(n, FOLLOW_STEPS_DEFAULT, FOLLOW_STEPS_MIN, FOLLOW_STEPS_MAX)
}

export function followPieceKey(state: GameState): string | null {
  const piece = state.piece
  if (!piece) return null
  return `${piece.type}|${state.lines}|${state.next}|${state.bag.join('')}`
}

/** After a successful human slide: fire teacher once m slides have landed. */
export function noteFollowHumanMove(opts: {
  pieceKey: string | null
  prevPieceKey: string | null
  humanCount: number
  humanMoves: number
}): { pieceKey: string | null; humanCount: number; teacherNow: boolean } {
  const m = clampFollowMoves(opts.humanMoves)
  const humanCount = opts.pieceKey !== opts.prevPieceKey ? 1 : opts.humanCount + 1
  if (humanCount >= m) {
    return { pieceKey: opts.pieceKey, humanCount: 0, teacherNow: true }
  }
  return { pieceKey: opts.pieceKey, humanCount, teacherNow: false }
}

function isFollowRotate(action: RlAction): boolean {
  return action === 'rotateCW' || action === 'rotateCCW'
}

/** Teacher may rotate freely; n only budgets left/right. Gravity still locks; no hardDrop. */
export function teacherFollowActions(state: GameState, n: number): RlAction[] {
  const budget = clampFollowSteps(n)
  const out: RlAction[] = []
  let laterals = 0
  for (const action of bestPlacementActions(state)) {
    if (action === 'hardDrop' || action === 'noop' || action === 'softDrop') continue
    if (isFollowRotate(action)) {
      out.push(action)
      continue
    }
    if (action !== 'left' && action !== 'right') continue
    if (laterals >= budget) break
    laterals++
    out.push(action)
  }
  return out
}

export function applyTeacherFollow(
  state: GameState,
  n: number,
  rng: () => number,
): { state: GameState; events: GameEvent[]; actions: RlAction[] } {
  const actions = teacherFollowActions(state, n)
  let current = state
  const events: GameEvent[] = []
  const done: RlAction[] = []
  for (const action of actions) {
    if (!current.piece || current.gameOver || current.anim) break
    const stepped = applyRlAction(current, action, rng)
    current = stepped.state
    events.push(...stepped.events)
    done.push(action)
  }
  return { state: current, events, actions: done }
}

export function describeCollabDecision(decision: CollabDecision, describe: (action: RlAction) => string): string {
  const label = describe(decision.action)
  const exp = decision.expected == null ? '' : ` · 本列 ${decision.expected.toFixed(1)}`
  const now = decision.lockNow == null ? '' : ` · 现落 ${decision.lockNow.toFixed(1)}`
  return `${label}${exp}${now}`
}

function applyRoot(state: GameState, action: RlAction): GameState {
  if (action === 'rotateCW') return rotate(state, 1, NOP_RNG).state
  if (action === 'rotateCCW') return rotate(state, -1, NOP_RNG).state
  return state
}

/** Prefer filling holes, then flattening / lowering the stack. */
export function packingScore(locked: GameState, before: BoardFeatures): number {
  if (locked.gameOver) return -80
  const after = boardFeatures(locked.board)
  return (
    -5.0 * (after.holes - before.holes) +
    -1.2 * (after.aggregateHeight - before.aggregateHeight) +
    -2.0 * (after.maxHeight - before.maxHeight) +
    -0.4 * (after.wells - before.wells)
  )
}

function evaluateState(state: GameState, before: BoardFeatures): number {
  return packingScore(simulateLock(state), before)
}

function holesAfterLock(state: GameState): number {
  return boardFeatures(simulateLock(state).board).holes
}

function cellsToGround(state: GameState): number {
  if (!state.piece) return 0
  return ghostY(state.board, state.piece) - state.piece.y
}

function occupiedCols(piece: Piece): number[] {
  const cols = new Set<number>()
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r]!.length; c++) {
      if (piece.matrix[r]![c]) cols.add(piece.x + c)
    }
  }
  return [...cols]
}

function wellDepth(heights: number[], col: number): number {
  if (col < 0 || col >= COLS) return 0
  const left = col === 0 ? ROWS : heights[col - 1]!
  const right = col === COLS - 1 ? ROWS : heights[col + 1]!
  return Math.max(0, Math.min(left, right) - heights[col]!)
}

/** Standing I is only useful if that one column is already a deep well. */
function standingIFillsWell(board: number[][], piece: Piece): boolean {
  if (piece.type !== 'I') return false
  const cols = occupiedCols(piece)
  if (cols.length !== 1) return false
  return wellDepth(columnHeights(board), cols[0]!) >= I_WELL_MIN
}

function allowsOrientation(state: GameState, next: GameState): boolean {
  if (!next.piece) return false
  if (next.piece.type !== 'I') return true
  const cols = occupiedCols(next.piece)
  if (cols.length !== 1) return true
  return standingIFillsWell(state.board, next.piece)
}

/**
 * Human already chose the column. Rotate for this x only.
 * I stays flat unless a ≥3-deep 1-wide well is already under the standing column.
 * Never rotate into more holes, especially on the last cell before lock.
 */
export function collabTeacherDecision(state: GameState, _options: CollabSearchOptions = {}): CollabDecision {
  const empty: CollabDecision = {
    action: 'noop',
    targetRot: null,
    expected: null,
    lockNow: null,
    reachable: 0,
  }
  if (!state.piece || state.gameOver || state.anim) return empty

  const before = boardFeatures(state.board)
  const locks = bfsLockScores(state)
  if (locks.length === 0) return empty

  const stayHoles = holesAfterLock(state)
  const lockNow = evaluateState(state, before)
  const landing = cellsToGround(state) <= 1 || collides(state.board, state.piece, 0, 1)

  const scored = ROOT_ACTIONS.map((action) => {
    const next = applyRoot(state, action)
    return {
      action,
      next,
      holes: holesAfterLock(next),
      local: evaluateState(next, before),
    }
  }).filter((item) => {
    if (item.action !== 'noop' && item.holes > stayHoles) return false
    if (item.action !== 'noop' && !allowsOrientation(state, item.next)) return false
    return true
  })

  const stay = scored.find((item) => item.action === 'noop')
  if (!stay) {
    return { action: 'noop', targetRot: state.piece.rot, expected: lockNow, lockNow, reachable: locks.length }
  }

  let chosen = stay
  const bestLocal = [...scored].sort((a, b) => b.local - a.local)[0]!
  if (bestLocal.local > stay.local + STAY_EPS) chosen = bestLocal
  if (landing && chosen.holes > stayHoles) chosen = stay

  return {
    action: chosen.action,
    targetRot:
      chosen.action === 'rotateCW'
        ? (state.piece.rot + 1) % 4
        : chosen.action === 'rotateCCW'
          ? (state.piece.rot + 3) % 4
          : state.piece.rot,
    expected: chosen.local,
    lockNow,
    reachable: locks.length,
  }
}
