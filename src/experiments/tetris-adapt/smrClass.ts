import type { TargetDir } from '../smr-adapt/smrControl'

export const FEET_CLASS_NAME = 'feet'
export const FEET_INTENDED_ACTION = 'hardDrop'

export type SmrClassName = 'left_hand' | 'right_hand' | 'both_hand' | 'rest' | 'feet'

export function classNameForSmrTarget(target: TargetDir): Exclude<SmrClassName, 'feet'> {
  if (target === 'left') return 'left_hand'
  if (target === 'right') return 'right_hand'
  if (target === 'up') return 'both_hand'
  return 'rest'
}
