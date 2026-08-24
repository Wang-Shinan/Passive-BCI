import {
  REVE_CURSOR_GAIN,
  reveCursorAxes,
  type TargetDir,
} from '../smr-adapt/smrControl'

export type CursorDrive = 'reve' | 'features'
export type OverlapAction = 'left' | 'right' | 'rotate' | 'down'

const LEFT_NAMES = new Set(['left_hand', 'left', 'left-hand', 'lefthand'])
const RIGHT_NAMES = new Set(['right_hand', 'right', 'right-hand', 'righthand'])
const UP_NAMES = new Set(['both_hand', 'both_hands', 'both', 'both-hand', 'up'])
const DOWN_NAMES = new Set(['rest', 'down', 'idle'])

export function normalizeClassName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_')
}

/** SMR 4-class → tetris-adapt directions. */
export function smrDirFromClassName(name: string): TargetDir | null {
  const key = normalizeClassName(name)
  if (LEFT_NAMES.has(key)) return 'left'
  if (RIGHT_NAMES.has(key)) return 'right'
  if (UP_NAMES.has(key)) return 'up'
  if (DOWN_NAMES.has(key)) return 'down'
  return null
}

export function overlapActionFromClassName(name: string): OverlapAction | null {
  const dir = smrDirFromClassName(name)
  if (dir === 'left') return 'left'
  if (dir === 'right') return 'right'
  if (dir === 'up') return 'rotate'
  if (dir === 'down') return 'down'
  return null
}

export function axesFromReve(
  classNames: readonly string[],
  probabilities: readonly number[],
): { zH: number; zV: number } | null {
  if (!classNames.length || classNames.length !== probabilities.length) return null
  const axes = reveCursorAxes(classNames, probabilities)
  return { zH: axes.zH * REVE_CURSOR_GAIN, zV: axes.zV * REVE_CURSOR_GAIN }
}

export function overlapActionFromAxes(
  zH: number,
  zV: number,
  deadzone = 0.45,
): OverlapAction | null {
  const ah = Math.abs(zH)
  const av = Math.abs(zV)
  if (ah < deadzone && av < deadzone) return null
  if (ah >= av) return zH < 0 ? 'left' : 'right'
  return zV > 0 ? 'rotate' : 'down'
}

export function describeOverlapAction(action: OverlapAction | null): string {
  if (action === 'left') return '← 左移'
  if (action === 'right') return '→ 右移'
  if (action === 'rotate') return '↻ 旋转'
  if (action === 'down') return '↓ 下落'
  return '—'
}
