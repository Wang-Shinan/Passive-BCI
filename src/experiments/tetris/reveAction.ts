import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { hardDrop, move, rotate, softDropBurst, type GameState, type StepResult } from './engine'

export const TETRIS_ACTION_SEMANTICS = 'tetris_action_7'

export const TETRIS_ACTION_CLASS_NAMES = [
  'rest',
  'left',
  'right',
  'rotateCW',
  'rotateCCW',
  'softDrop',
  'hardDrop',
] as const

export type TetrisActionClass = (typeof TETRIS_ACTION_CLASS_NAMES)[number]

export function isTetrisActionPrediction(prediction: ModelPrediction): boolean {
  return prediction.output_semantics === TETRIS_ACTION_SEMANTICS
}

export function tetrisActionLabelIndex(action: string): number | null {
  const index = (TETRIS_ACTION_CLASS_NAMES as readonly string[]).indexOf(action)
  return index >= 0 ? index : null
}

export function tetrisActionFromPrediction(prediction: ModelPrediction): TetrisActionClass | null {
  if (!isTetrisActionPrediction(prediction)) return null
  const byName = prediction.class_name
  if ((TETRIS_ACTION_CLASS_NAMES as readonly string[]).includes(byName)) {
    return byName as TetrisActionClass
  }
  return TETRIS_ACTION_CLASS_NAMES[prediction.class_id] ?? null
}

export function describeTetrisAction(action: string | null): string {
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
    case 'rest':
      return '— 无操作'
    default:
      return '—'
  }
}

export function shouldAutoLabelRest(actionCount: number, restCount: number): boolean {
  return restCount < actionCount
}

export function applyTetrisActionClass(
  state: GameState,
  action: TetrisActionClass,
  rng: () => number,
): StepResult | null {
  if (action === 'rest') return null
  if (state.gameOver || state.paused || state.anim) return null
  if (action === 'left') return move(state, -1, rng)
  if (action === 'right') return move(state, 1, rng)
  if (action === 'rotateCW') return rotate(state, 1, rng)
  if (action === 'rotateCCW') return rotate(state, -1, rng)
  if (action === 'hardDrop') return hardDrop(state, rng)
  if (action === 'softDrop') return softDropBurst(state, rng, 1 / 60, 24)
  return null
}
