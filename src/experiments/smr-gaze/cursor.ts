import type { Direction } from './classifier'

export type CursorPosition = { x: number; y: number }
export const CONTROL_SPEED_PER_SEC = 0.54
export const CONTROL_TARGET_SEC = 12
export function reachedEdge(position: CursorPosition, target: Direction): boolean {
  return target === 'left' ? position.x <= 0.06 : target === 'right' ? position.x >= 0.94
    : target === 'up' ? position.y <= 0.06 : position.y >= 0.94
}
export function moveProbabilityCursor(position: CursorPosition, p: readonly number[], dt: number): CursorPosition {
  if (p.length !== 4 || p.some(v => !Number.isFinite(v) || v < 0) || !Number.isFinite(dt) || dt <= 0) return position
  const total = p.reduce((a, b) => a + b, 0)
  if (total <= 0) return position
  const distance = Math.min(dt, 0.1) * CONTROL_SPEED_PER_SEC / total
  return {
    x: Math.max(0.04, Math.min(0.96, position.x + (p[1]! - p[0]!) * distance)),
    y: Math.max(0.04, Math.min(0.96, position.y + (p[3]! - p[2]!) * distance)),
  }
}
const VECTOR: Record<Direction, CursorPosition> = {
  left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
}

/** Normalized arena coordinates; cap catch-up so a stalled frame cannot teleport. */
export function moveCursor(position: CursorPosition, direction: Direction | null, dt: number): CursorPosition {
  if (!direction || !Number.isFinite(dt) || dt <= 0) return position
  const distance = Math.min(dt, 0.1) * 0.18
  const vector = VECTOR[direction]
  return {
    x: Math.max(0.04, Math.min(0.96, position.x + vector.x * distance)),
    y: Math.max(0.04, Math.min(0.96, position.y + vector.y * distance)),
  }
}
