import {
  advanceFall,
  hardDrop,
  move,
  rotate,
  softDropBurst,
  type GameState,
  type StepResult,
} from '../engine'
import {
  RL_ACTION_NAMES,
  RL_DECISION_DT_SEC,
  RL_SOFT_DROP_CELLS_PER_SEC,
  type RlAction,
} from './contracts'
import { instantResolveAnim } from './instantResolve'

export function actionFromIndex(index: number): RlAction {
  return RL_ACTION_NAMES[index] ?? 'noop'
}

export function actionToIndex(action: RlAction): number {
  const idx = RL_ACTION_NAMES.indexOf(action)
  return idx >= 0 ? idx : 0
}

export interface RlStepOptions {
  cellsPerSec: number
  dtSec?: number
  instantAnim?: boolean
}

/** Apply one RL action then integrate gravity for one decision interval. */
export function applyRlAction(
  state: GameState,
  action: RlAction,
  rng: () => number,
): StepResult {
  if (state.gameOver || state.paused || state.anim) return { state, events: [] }

  switch (action) {
    case 'left':
      return move(state, -1, rng)
    case 'right':
      return move(state, 1, rng)
    case 'rotateCW':
      return rotate(state, 1, rng)
    case 'rotateCCW':
      return rotate(state, -1, rng)
    case 'hardDrop':
      return hardDrop(state, rng)
    case 'noop':
    case 'softDrop':
    default:
      return { state, events: [] }
  }
}

/** Full RL step: action + gravity (+ optional instant anim resolve). */
export function rlStep(
  state: GameState,
  action: RlAction,
  rng: () => number,
  opts: RlStepOptions,
): StepResult {
  const dtSec = opts.dtSec ?? RL_DECISION_DT_SEC
  const events = []

  let current = state
  if (!current.gameOver && !current.paused && !current.anim) {
    const acted = applyRlAction(current, action, rng)
    current = acted.state
    events.push(...acted.events)
  }

  if (current.gameOver || current.paused) {
    return { state: current, events }
  }

  if (current.anim) {
    if (opts.instantAnim) {
      const resolved = instantResolveAnim(current, rng)
      current = resolved.state
      events.push(...resolved.events)
    } else {
      return { state: current, events }
    }
  }

  if (current.gameOver || current.paused || current.anim) {
    return { state: current, events }
  }

  if (current.piece) {
    const speed =
      action === 'softDrop'
        ? Math.max(opts.cellsPerSec, RL_SOFT_DROP_CELLS_PER_SEC)
        : opts.cellsPerSec
    const fall =
      action === 'softDrop'
        ? softDropBurst(current, rng, dtSec, speed)
        : advanceFall(current, rng, dtSec, speed, false)
    current = fall.state
    events.push(...fall.events)
  }

  if (opts.instantAnim && current.anim) {
    const resolved = instantResolveAnim(current, rng)
    current = resolved.state
    events.push(...resolved.events)
  }

  return { state: current, events }
}

export function describeRlAction(action: RlAction): string {
  switch (action) {
    case 'left':
      return '← 左移'
    case 'right':
      return '→ 右移'
    case 'rotateCW':
      return '↻ 顺时针'
    case 'rotateCCW':
      return '↺ 逆时针'
    case 'softDrop':
      return '↓ 软降'
    case 'hardDrop':
      return '⬇ 硬降'
    default:
      return '— 无操作'
  }
}
