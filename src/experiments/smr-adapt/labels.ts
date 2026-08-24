import type { TargetDir } from './smrControl'

const ALIASES: Record<TargetDir, string[]> = {
  right: ['right', 'right_hand', 'right-hand', 'righthand'],
  left: ['left', 'left_hand', 'left-hand', 'lefthand'],
  up: ['up', 'both', 'both_hand', 'both-hand', 'both_hands', 'bothhands'],
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
