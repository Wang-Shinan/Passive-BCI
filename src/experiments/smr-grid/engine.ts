import { labelIndexForTarget } from '../smr-adapt/labels'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'

export type Point = { x: number; y: number }
export type GridState = { n: number; cursor: Point; corridorStart: Point; target: number; hits: number; elapsed: number; lastHit: number | null }
export const GRID_SIGNAL_MAX_AGE_MS = 1500
export const GRID_CURSOR_PAD = 0.018
export const SMR_GRID_STEP_SEC = 0.1

export type CorridorMode = 'hard' | 'soft'
export type DualAxisPolicy = 'target' | 'horizontal' | 'vertical' | 'simultaneous'
export type ActiveDualAxis = 'horizontal' | 'vertical' | 'both'

export type CardinalDirection = 'left' | 'right' | 'up' | 'down'

/** A four-class decision drives exactly one cardinal direction. */
export function cardinalDirectionAxes(direction: string, magnitude = 1): Point {
  const value = Number.isFinite(magnitude) ? Math.max(0, magnitude) : 0
  if (direction === 'left') return { x: -value, y: 0 }
  if (direction === 'right') return { x: value, y: 0 }
  if (direction === 'up') return { x: 0, y: -value }
  if (direction === 'down') return { x: 0, y: value }
  return { x: 0, y: 0 }
}

/** Keep only the unique winning class and its margin over the runner-up. */
export function smrCardinalLogitAxes(pred: Pick<ModelPrediction, 'class_names' | 'probabilities' | 'logits'>): Point | null {
  const directions = ['left', 'right', 'up', 'down'] as const
  const indices = directions.map(dir => labelIndexForTarget(pred.class_names, dir))
  if (indices.some(i => i === null)) return null
  const logits = pred.logits ?? pred.probabilities.map(p => Math.log(Math.max(1e-12, p)))
  if (logits.length !== pred.class_names.length || !logits.every(Number.isFinite)) return null
  const scores = indices.map(i => logits[i!]!)
  let winner = 0
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[winner]!) winner = i
  const runnerUp = Math.max(...scores.filter((_, i) => i !== winner))
  const margin = scores[winner]! - runnerUp
  return margin > 1e-12 ? cardinalDirectionAxes(directions[winner]!, margin) : { x: 0, y: 0 }
}

/** Opposing-class logit contrasts, invariant to the arbitrary common logit offset. */
export function smrLogitAxes(pred: Pick<ModelPrediction, 'class_names' | 'probabilities' | 'logits'>): Point | null {
  const indices = (['left', 'right', 'up', 'down'] as const).map(dir => labelIndexForTarget(pred.class_names, dir))
  if (indices.some(i => i === null)) return null
  const logits = pred.logits ?? pred.probabilities.map(p => Math.log(Math.max(1e-12, p)))
  if (logits.length !== pred.class_names.length || !logits.every(Number.isFinite)) return null
  const [left, right, up, down] = indices.map(i => logits[i!]!)
  return { x: right! / 2 - left! / 2, y: down! / 2 - up! / 2 }
}

/** Keep a target-guided axis until the cursor enters the target row/column. */
export function targetControlAxis(state: GridState, previous?: Exclude<ActiveDualAxis, 'both'>): Exclude<ActiveDualAxis, 'both'> {
  const target = targetCenter(state.target, state.n)
  const dx = Math.abs(target.x - state.cursor.x), dy = Math.abs(target.y - state.cursor.y)
  const aligned = 0.45 / state.n
  if (previous === 'horizontal' && dx > aligned) return previous
  if (previous === 'vertical' && dy > aligned) return previous
  if (dx <= aligned && dy > aligned) return 'vertical'
  if (dy <= aligned && dx > aligned) return 'horizontal'
  if (dx !== dy) return dx > dy ? 'horizontal' : 'vertical'
  return state.target % 2 === 0 ? 'vertical' : 'horizontal'
}

/** Binary models are conditional on a known axis; mask the out-of-axis output. */
export function applyDualAxisPolicy(state: GridState, axes: Point, policy: DualAxisPolicy, previous?: Exclude<ActiveDualAxis, 'both'>): { axes: Point; active: ActiveDualAxis } {
  if (policy === 'simultaneous') return { axes, active: 'both' }
  let active: 'horizontal' | 'vertical' = policy === 'vertical' ? 'vertical' : 'horizontal'
  if (policy === 'target') active = targetControlAxis(state, previous)
  return active === 'horizontal'
    ? { axes: { x: axes.x, y: 0 }, active }
    : { axes: { x: 0, y: axes.y }, active }
}

/** Weak inward field in logit-contrast units; starts in the outer 20% of the radius. */
export function softCorridorField(point: Point, start: Point, end: Point, fullWidth: number, strength: number): Point {
  if (!Number.isFinite(fullWidth) || fullWidth <= 0 || !Number.isFinite(strength) || strength <= 0) return { x: 0, y: 0 }
  const nearest = constrainToCorridor(point, start, end, 0)
  const dx = nearest.x - point.x, dy = nearest.y - point.y
  const distance = Math.hypot(dx, dy), radius = fullWidth / 2
  const penetration = Math.max(0, distance - radius * 0.8)
  if (penetration === 0) return { x: 0, y: 0 }
  const magnitude = Math.min(1, strength) * Math.tanh(penetration / radius)
  return { x: dx / distance * magnitude, y: dy / distance * magnitude }
}

/** Add the field BEFORE the bounded action mapping, not to probabilities or hard votes. */
export function softGridAction(state: GridState, logits: Point | null, widthCells: number, strength: number): { action: Point; field: Point } {
  if (!logits || !Number.isFinite(logits.x) || !Number.isFinite(logits.y)) return { action: { x: 0, y: 0 }, field: { x: 0, y: 0 } }
  const field = softCorridorField(state.cursor, state.corridorStart, targetCenter(state.target, state.n), widthCells / state.n, strength)
  return { field, action: { x: 0.25 * Math.tanh(logits.x + field.x), y: 0.25 * Math.tanh(logits.y + field.y) } }
}

export function targetCenter(target: number, n: number): Point {
  return { x: (target % n + 0.5) / n, y: (Math.floor(target / n) + 0.5) / n }
}

/** Project onto a fixed capsule around the start-to-target segment, with no forward assistance. */
export function constrainToCorridor(point: Point, start: Point, end: Point, fullWidth: number): Point {
  const dx = end.x - start.x, dy = end.y - start.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq)) : 0
  const nearest = { x: start.x + t * dx, y: start.y + t * dy }
  const offsetX = point.x - nearest.x, offsetY = point.y - nearest.y
  const distance = Math.hypot(offsetX, offsetY)
  const radius = Math.max(0, fullWidth) / 2
  if (distance <= radius) return point
  const scale = radius / distance
  return { x: nearest.x + offsetX * scale, y: nearest.y + offsetY * scale }
}

export function cellAt(point: Point, n: number): number {
  const index = (value: number) => Math.max(0, Math.min(n - 1, Math.floor(value * n)))
  return index(point.y) * n + index(point.x)
}

/** Uniform among every cell except the one occupied by the cursor. */
export function randomTarget(n: number, occupied: number, rng = Math.random): number {
  const pick = Math.min(n * n - 2, Math.max(0, Math.floor(rng() * (n * n - 1))))
  return pick >= occupied ? pick + 1 : pick
}

export function createGrid(n = 3, rng = Math.random): GridState {
  n = Number.isFinite(n) ? Math.max(2, Math.min(8, Math.round(n))) : 3
  const cursor = { x: 0.5, y: 0.5 }
  return { n, cursor, corridorStart: cursor, target: randomTarget(n, cellAt(cursor, n), rng), hits: 0, elapsed: 0, lastHit: null }
}

/** Screen coordinates: positive y moves down. A hit never resets position. */
export function stepGrid(state: GridState, velocity: Point, dt: number, gain: number, rng = Math.random, corridorWidthCells: number | null = null): GridState {
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(gain)) return state
  // Avoid jumps after a suspended/background tab; also cannot skip a whole cell.
  const seconds = Math.min(dt, 0.05)
  const step = (position: number, drive: number) => Math.max(GRID_CURSOR_PAD, Math.min(1 - GRID_CURSOR_PAD,
    position + (Number.isFinite(drive) ? Math.max(-1, Math.min(1, drive)) : 0) * seconds * Math.max(0, Math.min(2, gain))))
  const proposed = { x: step(state.cursor.x, velocity.x), y: step(state.cursor.y, velocity.y) }
  const cursor = corridorWidthCells !== null && Number.isFinite(corridorWidthCells)
    ? constrainToCorridor(proposed, state.corridorStart, targetCenter(state.target, state.n), corridorWidthCells / state.n)
    : proposed
  const occupied = cellAt(cursor, state.n)
  const hit = occupied === state.target
  const elapsed = state.elapsed + seconds
  return { ...state, cursor, elapsed, corridorStart: hit ? cursor : state.corridorStart,
    target: hit ? randomTarget(state.n, occupied, rng) : state.target,
    hits: state.hits + Number(hit), lastHit: hit ? elapsed : state.lastHit }
}

export function validSmrPrediction(pred: ModelPrediction | null, now: number, dual = false): pred is ModelPrediction {
  const validTask = pred && (dual
    ? pred.task === 'smr_dual_axis' && pred.output_semantics === 'smr_independent_binary_axes' &&
      pred.class_names.join(',') === 'left_hand,right_hand,tongue,rest' && pred.logits?.length === 4 &&
      Math.abs(pred.probabilities[0]! + pred.probabilities[1]! - 1) < 1e-5 &&
      Math.abs(pred.probabilities[2]! + pred.probabilities[3]! - 1) < 1e-5
    : !pred.task || pred.task === 'smr_control')
  return Boolean(pred && validTask &&
    now - pred.received_at_ms >= 0 && now - pred.received_at_ms <= GRID_SIGNAL_MAX_AGE_MS &&
    pred.class_names.length === pred.probabilities.length &&
    pred.probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1) &&
    pred.probabilities.reduce((a, b) => a + b, 0) > 0 &&
    (!pred.logits || (pred.logits.length === pred.class_names.length && pred.logits.every(Number.isFinite))) &&
    ['left', 'right', 'up', 'down'].every(dir => labelIndexForTarget(pred.class_names, dir as 'left' | 'right' | 'up' | 'down') !== null))
}

export function keyboardVelocity(keys: ReadonlySet<string>): Point {
  const x = Number(keys.has('ArrowRight') || keys.has('KeyD')) - Number(keys.has('ArrowLeft') || keys.has('KeyA'))
  const y = Number(keys.has('ArrowDown') || keys.has('KeyS')) - Number(keys.has('ArrowUp') || keys.has('KeyW'))
  const scale = 0.25 / Math.max(1, Math.hypot(x, y))
  return { x: x * scale, y: y * scale }
}
