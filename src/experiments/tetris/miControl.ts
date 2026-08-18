import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { move, rotate, type GameState, type StepResult } from './engine'

export type MiControlAction = 'left' | 'right' | 'rotate' | 'none'

const CLASS_TO_ACTION: Record<string, MiControlAction> = {
  left: 'left',
  left_hand: 'left',
  right: 'right',
  right_hand: 'right',
  feet: 'rotate',
  both: 'rotate',
  both_hand: 'rotate',
  both_hands: 'rotate',
  up: 'rotate',
  tongue: 'none',
  rest: 'none',
  down: 'none',
  idle: 'none',
}

export const SMR_CONTROL_SEMANTICS = 'smr_control_4'

export function isSmrControlPrediction(prediction: ModelPrediction): boolean {
  return prediction.output_semantics === SMR_CONTROL_SEMANTICS || prediction.task === 'smr_control'
}

export function miControlActionForClassName(name: string): MiControlAction | null {
  return CLASS_TO_ACTION[name] ?? null
}

export function miControlActionForPrediction(
  prediction: ModelPrediction,
): MiControlAction | null {
  return (
    miControlActionForClassName(prediction.class_name) ??
    miControlActionForClassName(prediction.class_names[prediction.class_id] ?? '')
  )
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
