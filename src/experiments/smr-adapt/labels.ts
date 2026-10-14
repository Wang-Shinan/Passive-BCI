import type { TargetDir } from './smrControl'

export const SMR_IMAGERY_SCHEMA = 'left-right-tongue-rest-v1'
export const SMR_CLASS_NAMES = ['left_hand', 'right_hand', 'tongue', 'rest'] as const
export const SMR_TARGET_CLASSES = { left: 'left_hand', right: 'right_hand', up: 'tongue', down: 'rest' } as const

const ALIASES: Record<TargetDir, string[]> = {
  right: ['right', 'right_hand', 'right-hand', 'righthand'],
  left: ['left', 'left_hand', 'left-hand', 'lefthand'],
  up: ['up', 'tongue'],
  down: ['down', 'rest', 'idle'],
}

export function normalizeClassName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_')
}

export function labelIndexForTarget(
  classNames: readonly string[],
  target: TargetDir,
): number | null {
  const wanted = new Set(ALIASES[target].map(normalizeClassName))
  const index = classNames.findIndex((name) => wanted.has(normalizeClassName(name)))
  return index >= 0 ? index : null
}

export function canLabelSmrHead(classNames: readonly string[] | undefined): boolean {
  if (!classNames?.length) return false
  return (['left', 'right', 'up', 'down'] as const).every(
    (target) => labelIndexForTarget(classNames, target) != null,
  )
}
