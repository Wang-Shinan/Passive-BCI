import {
  SMR_TICK_SEC,
  hitEdge,
  outcomeForHit,
  pvc,
  smrClassMasses,
  type TrialOutcome,
} from '../smr-adapt/smrControl'

export const UD_TICK_SEC = SMR_TICK_SEC
export const UD_DEADZONE = 0.08
export const UD_REST_SEC = 2
export const UD_FEEDBACK_SEC = 8
export const UD_TARGET_SEC = UD_FEEDBACK_SEC
export const UD_HIT_PAD = 0.055
export const UD_KEY_STRENGTH = 1
export const UD_TRAIL = 14
export const UD_CENTER_Y = 0.5
export const UD_DEFAULT_GAIN = 0.28
export const UD_GAIN_MIN = 0.08
export const UD_GAIN_MAX = 1
export const UD_GAIN_KEY = 'passive-bci.smr-ud-gain'

export type UdDir = 'up' | 'down'
export type UdIntent = 'up' | 'down' | 'idle'

export type UdScore = {
  hits: number
  misses: number
  timeouts: number
  n: number
  pvc: number
}

export function applyDeadzone(z: number, dz = UD_DEADZONE): number {
  return Math.abs(z) < dz ? 0 : z
}

export function stepUdY(y: number, zV: number, dtSec = UD_TICK_SEC, gain = UD_DEFAULT_GAIN): number {
  return Math.max(0, Math.min(1, y + gain * zV * dtSec))
}

export function clampGain(value: number): number {
  if (!Number.isFinite(value)) return UD_DEFAULT_GAIN
  return Math.max(UD_GAIN_MIN, Math.min(UD_GAIN_MAX, value))
}

export function loadGain(): number {
  if (typeof window === 'undefined') return UD_DEFAULT_GAIN
  const raw = window.localStorage.getItem(UD_GAIN_KEY)
  if (raw == null) return UD_DEFAULT_GAIN
  return clampGain(Number(raw))
}

export function saveGain(value: number): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(UD_GAIN_KEY, String(clampGain(value)))
}

export function hitUdEdge(y: number, pad = UD_HIT_PAD): UdDir | null {
  const hit = hitEdge({ x: 0.5, y }, pad)
  if (hit === 'up' || hit === 'down') return hit
  return null
}

export function keyboardZV(
  upHeld: boolean,
  downHeld: boolean,
  strength = UD_KEY_STRENGTH,
): number | null {
  if (upHeld === downHeld) return null
  return upHeld ? strength : -strength
}

export function mixControl(neuralZV: number, keyZV: number | null): number {
  return keyZV ?? neuralZV
}

export function udIntent(zV: number, threshold = 0.18): UdIntent {
  if (zV >= threshold) return 'up'
  if (zV <= -threshold) return 'down'
  return 'idle'
}

export function nextTarget(prev: UdDir | null, rng: () => number): UdDir {
  if (prev == null) return rng() < 0.5 ? 'up' : 'down'
  return rng() < 0.72 ? (prev === 'up' ? 'down' : 'up') : prev
}

export function resolveUdTarget(
  y: number,
  target: UdDir,
  elapsedSec: number,
  limitSec = UD_FEEDBACK_SEC,
  pad = UD_HIT_PAD,
): TrialOutcome | null {
  const hit = hitUdEdge(y, pad)
  if (hit || elapsedSec >= limitSec) return outcomeForHit(target, hit, elapsedSec >= limitSec)
  return null
}

export function summarizeUd(outcomes: readonly TrialOutcome[]): UdScore {
  const hits = outcomes.filter((item) => item === 'hit').length
  const misses = outcomes.filter((item) => item === 'miss').length
  const timeouts = outcomes.filter((item) => item === 'timeout').length
  return {
    hits,
    misses,
    timeouts,
    n: outcomes.length,
    pvc: pvc(outcomes),
  }
}

export function decayToward(value: number, dtSec: number, tau = 0.28): number {
  if (tau <= 0) return 0
  return value * Math.exp(-dtSec / tau)
}

export class RunningNorm {
  n = 0
  mean = 0
  m2 = 0

  push(x: number): void {
    this.n += 1
    const d = x - this.mean
    this.mean += d / this.n
    this.m2 += d * (x - this.mean)
  }

  z(x: number, minN = 12, minStd = 0.05): number {
    if (this.n < minN) return 0
    const std = Math.sqrt(this.m2 / Math.max(1, this.n - 1))
    return (x - this.mean) / Math.max(minStd, std)
  }
}

export type UdBars = {
  up: number
  down: number
  left: number
  right: number
  upShare: number
  downShare: number
  pairMass: number
  zV: number
}

/** Contrast both_hand vs rest even when left/right take most of the softmax. */
export function udPairDrive(up: number, down: number, eps = 1e-6): {
  zV: number
  upShare: number
  downShare: number
  pairMass: number
} {
  const pairMass = Math.max(0, up) + Math.max(0, down)
  if (pairMass <= eps) {
    return { zV: 0, upShare: 0.5, downShare: 0.5, pairMass }
  }
  return {
    zV: (up - down) / pairMass,
    upShare: up / pairMass,
    downShare: down / pairMass,
    pairMass,
  }
}

export function udBars(
  classNames: readonly string[],
  probabilities: readonly number[],
): UdBars {
  const mass = smrClassMasses(classNames, probabilities)
  const pair = udPairDrive(mass.up, mass.down)
  return {
    ...mass,
    ...pair,
  }
}

export function pushTrail(trail: readonly number[], y: number, max = UD_TRAIL): number[] {
  const next = trail.length >= max ? trail.slice(trail.length - max + 1) : [...trail]
  next.push(y)
  return next
}
