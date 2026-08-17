import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { move, rotate, type GameState, type StepResult } from './engine'

export type MiControlAction = 'left' | 'right' | 'rotate' | 'none'

const CLASS_TO_ACTION: Record<string, MiControlAction> = {
  left_hand: 'left',
  right_hand: 'right',
  feet: 'rotate',
  tongue: 'none',
}

export function miControlActionForPrediction(
  prediction: ModelPrediction,
): MiControlAction | null {
  const byName = CLASS_TO_ACTION[prediction.class_name]
  if (byName) return byName
  const byId = CLASS_TO_ACTION[prediction.class_names[prediction.class_id] ?? '']
  return byId ?? null
}

export function applyMiControlAction(
  state: GameState,
  action: MiControlAction,
  rng: () => number,
): StepResult | null {
  if (action === 'none') return null
  if (action === 'left') return move(state, -1, rng)
  if (action === 'right') return move(state, 1, rng)
  return rotate(state, 1, rng)
}

export function describeMiControlAction(action: MiControlAction | null): string {
  if (action === 'left') return '← 左移'
  if (action === 'right') return '→ 右移'
  if (action === 'rotate') return '↻ 旋转'
  if (action === 'none') return '静止'
  return '—'
}
