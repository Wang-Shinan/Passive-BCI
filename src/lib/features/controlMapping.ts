/** Map live feature scalars → 0–100 control channels. */

import { softScore } from './featureCatalog'

export type SignalControlMode = 'manual' | 'features'

export const SIGNAL_MODE_STORAGE_KEY = 'passive-bci.signal-control-mode'
export const STRESS_DRIVER_STORAGE_KEY = 'passive-bci.stress-driver-feature'

/** Direct demo envelope id — bypasses flat softScore compression. */
export const DEMO_ENVELOPE_DRIVER = 'demo_envelope'

/** Features suitable as tonic stress / load drivers. */
export const STRESS_DRIVER_OPTIONS: { id: string; label: string }[] = [
  { id: DEMO_ENVELOPE_DRIVER, label: '演示包络（可见波动）' },
  { id: 'cognitive_load', label: 'cognitive_load' },
  { id: 'focus_score', label: 'focus_score' },
  { id: 'engagement_score', label: 'engagement_score' },
  { id: 'drowsiness', label: 'drowsiness' },
  { id: 'tbr_theta_beta', label: 'θ/β' },
  { id: 'bar_beta_alpha', label: 'β/α' },
  { id: 'rel_power_beta', label: 'rel β' },
  { id: 'rel_power_alpha', label: 'rel α (↓压力)' },
]

export const AFFECT_DRIVER_DEFAULTS = {
  satisfaction: 'relaxation_score',
  surprise: 'cognitive_load',
  focus: 'focus_score',
  arousal: 'engagement_score',
} as const

export type AffectChannel = keyof typeof AFFECT_DRIVER_DEFAULTS

/** Soft-map a feature value into 0–100 for game control. */
export function mapFeatureToControl100(featureId: string, raw: number): number {
  if (!Number.isFinite(raw)) return 50

  if (featureId.startsWith('rel_power_')) {
    const pct = Math.max(0, Math.min(100, raw * 100 * 2.2))
    if (featureId === 'rel_power_alpha') return Math.max(0, Math.min(100, 100 - pct))
    return pct
  }

  if (
    featureId === 'spect_entropy' ||
    featureId === 'perm_entropy' ||
    featureId === 'lziv_complexity' ||
    featureId === 'svd_entropy'
  ) {
    return Math.max(0, Math.min(100, raw * 100))
  }

  if (
    featureId.endsWith('_score') ||
    featureId === 'cognitive_load' ||
    featureId === 'drowsiness' ||
    featureId.startsWith('tbr_') ||
    featureId.startsWith('tar_') ||
    featureId.startsWith('bar_')
  ) {
    // Wider mapping than softScore alone — keep more dynamic range for control.
    const soft = softScore(raw, featureId === 'cognitive_load' || featureId === 'drowsiness' ? 1.2 : 1)
    // Stretch around mid: 30–70 → ~5–95-ish when soft varies modestly
    return Math.max(0, Math.min(100, (soft - 50) * 2.2 + 50))
  }

  return softScore(Math.abs(raw), Math.max(1, Math.abs(raw) * 0.5 + 0.5))
}

/** Rolling min/max rescale so modest feature drift still spans ~10–90. */
export function adaptiveScale100(
  mapped: number,
  state: { min: number; max: number },
  floor = 8,
  ceil = 92,
): number {
  if (!Number.isFinite(mapped)) return 50
  state.min = Math.min(state.min, mapped)
  state.max = Math.max(state.max, mapped)
  // Slow expand forget — keep adapting to new ranges
  const span = state.max - state.min
  if (span < 4) {
    // Not enough contrast yet — keep raw-ish around center
    return Math.max(floor, Math.min(ceil, mapped))
  }
  const t = (mapped - state.min) / span
  return floor + t * (ceil - floor)
}

export function loadSignalMode(): SignalControlMode {
  try {
    const v = localStorage.getItem(SIGNAL_MODE_STORAGE_KEY)
    return v === 'features' ? 'features' : 'manual'
  } catch {
    return 'manual'
  }
}

export function saveSignalMode(mode: SignalControlMode): void {
  localStorage.setItem(SIGNAL_MODE_STORAGE_KEY, mode)
}

export function loadStressDriver(): string {
  try {
    const v = localStorage.getItem(STRESS_DRIVER_STORAGE_KEY)
    if (v && STRESS_DRIVER_OPTIONS.some((o) => o.id === v)) return v
  } catch {
    /* ignore */
  }
  return DEMO_ENVELOPE_DRIVER
}

export function saveStressDriver(id: string): void {
  localStorage.setItem(STRESS_DRIVER_STORAGE_KEY, id)
}

/** Exponential moving average toward target. */
export function ema(prev: number, next: number, alpha = 0.18): number {
  return prev * (1 - alpha) + next * alpha
}
