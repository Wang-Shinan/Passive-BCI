/** Map live feature scalars → 0–100 control channels. */

import { softScore } from './featureCatalog'

export type SignalControlMode = 'manual' | 'features'

export const SIGNAL_MODE_STORAGE_KEY = 'passive-bci.signal-control-mode'
export const STRESS_DRIVER_STORAGE_KEY = 'passive-bci.stress-driver-feature'

/** Direct demo envelope id — bypasses feature mapping for visible swings. */
export const DEMO_ENVELOPE_DRIVER = 'demo_envelope'

export type ControlSignalTier = 'S' | 'A' | 'B' | 'C' | 'demo'

export type ControlSignalOption = {
  id: string
  label: string
  tier: ControlSignalTier
  /** Short note for UI */
  note?: string
}

/**
 * C-tier and above — optional drivers for difficulty / informational control.
 * Evidence: offline SVM consensus + E3 ablation (D-tier ratios excluded as sole drivers).
 */
export const CONTROL_SIGNAL_OPTIONS: ControlSignalOption[] = [
  {
    id: DEMO_ENVELOPE_DRIVER,
    label: '演示包络',
    tier: 'demo',
    note: '合成调制直接驱动，便于看见波动',
  },
  // S — amplitude
  { id: 'rms', label: 'rms', tier: 'S', note: '幅度 · 首选' },
  { id: 'std', label: 'std', tier: 'S' },
  { id: 'ptp_amp', label: 'ptp_amp', tier: 'S' },
  { id: 'line_length', label: 'line_length', tier: 'S' },
  // A
  { id: 'petrosian_fd', label: 'petrosian_fd', tier: 'A' },
  {
    id: 'energy_freq_bands',
    label: 'energy_freq_bands (Σ)',
    tier: 'A',
    note: '各频带绝对能量求和',
  },
  { id: 'perm_entropy', label: 'perm_entropy', tier: 'A' },
  { id: 'spect_slope', label: 'spect_slope', tier: 'A' },
  // B
  { id: 'hjorth_complexity', label: 'hjorth_complexity', tier: 'B' },
  { id: 'higuchi_fd', label: 'higuchi_fd', tier: 'B', note: '计算偏重' },
  { id: 'teager_kaiser_energy', label: 'teager_kaiser_energy', tier: 'B' },
  { id: 'hjorth_mobility_spect', label: 'hjorth_mobility_spect', tier: 'B' },
  // C — bands / heuristic scores (ok as optional, not sole offline winners)
  {
    id: 'pow_freq_bands',
    label: 'pow_freq_bands → β/α',
    tier: 'C',
    note: '相对频带导出 β/α',
  },
  { id: 'rel_power_beta', label: 'rel β', tier: 'C' },
  { id: 'rel_power_alpha', label: 'rel α (↓压力)', tier: 'C' },
  { id: 'focus_score', label: 'focus_score', tier: 'C' },
  { id: 'engagement_score', label: 'engagement_score', tier: 'C' },
  { id: 'relaxation_score', label: 'relaxation_score', tier: 'C' },
  { id: 'cognitive_load', label: 'cognitive_load', tier: 'C' },
  { id: 'drowsiness', label: 'drowsiness', tier: 'C' },
]

/** @deprecated alias — same as CONTROL_SIGNAL_OPTIONS for stress dropdowns */
export const STRESS_DRIVER_OPTIONS = CONTROL_SIGNAL_OPTIONS.map((o) => ({
  id: o.id,
  label: o.tier === 'demo' ? o.label : `[${o.tier}] ${o.label}`,
}))

export const CONTROL_SIGNAL_TIER_ORDER: ControlSignalTier[] = ['demo', 'S', 'A', 'B', 'C']

export const CONTROL_SIGNAL_TIER_LABEL: Record<ControlSignalTier, string> = {
  demo: '演示',
  S: 'S · 幅度（优先）',
  A: 'A · 能量 / 熵 / 斜率',
  B: 'B · Hjorth / 分形',
  C: 'C · 频带 / 启发式评分',
}

/** Draw-guess defaults: mix S/A/B/C informational channels. */
export const AFFECT_DRIVER_DEFAULTS = {
  satisfaction: 'relaxation_score',
  surprise: 'rms',
  focus: 'hjorth_complexity',
  arousal: 'std',
} as const

export type AffectChannel = keyof typeof AFFECT_DRIVER_DEFAULTS

/** Catalog feature ids that must be computed for a driver. */
export function ensureIdsForDriver(driverId: string): string[] {
  if (driverId === DEMO_ENVELOPE_DRIVER) return ['rms', 'pow_freq_bands']
  if (driverId === 'energy_freq_bands') return ['energy_freq_bands']
  if (driverId === 'pow_freq_bands') return ['pow_freq_bands']
  if (driverId.startsWith('rel_power_')) return ['pow_freq_bands']
  if (driverId.startsWith('energy_')) return ['energy_freq_bands']
  if (
    driverId.endsWith('_score') ||
    driverId === 'cognitive_load' ||
    driverId === 'drowsiness'
  ) {
    return [driverId, 'pow_freq_bands']
  }
  return [driverId]
}

/** Read scalar used for control from a feature snapshot. */
export function resolveDriverRaw(
  values: Record<string, number>,
  driverId: string,
): number | undefined {
  if (driverId === 'energy_freq_bands') {
    let sum = 0
    let n = 0
    for (const [k, v] of Object.entries(values)) {
      if (!k.startsWith('energy_') || !Number.isFinite(v)) continue
      sum += v
      n++
    }
    return n ? sum : undefined
  }
  if (driverId === 'pow_freq_bands') {
    const a = values.rel_power_alpha
    const b = values.rel_power_beta
    if (a === undefined || b === undefined) return undefined
    return b / (a + 1e-12)
  }
  const v = values[driverId]
  return v !== undefined && Number.isFinite(v) ? v : undefined
}

/** Soft-map a feature value into 0–100 for game control (before adaptive rescale). */
export function mapFeatureToControl100(featureId: string, raw: number): number {
  if (!Number.isFinite(raw)) return 50

  // Amplitude / length — log-ish compress μV-scale values into a usable band.
  if (
    featureId === 'rms' ||
    featureId === 'std' ||
    featureId === 'ptp_amp' ||
    featureId === 'line_length' ||
    featureId === 'teager_kaiser_energy' ||
    featureId === 'energy_freq_bands' ||
    featureId.startsWith('energy_')
  ) {
    const x = Math.max(0, raw)
    // log1p maps typical EEG μV ranges without saturating immediately
    return Math.max(0, Math.min(100, (Math.log1p(x) / Math.log1p(80)) * 100))
  }

  if (featureId === 'spect_slope') {
    // Usually negative; steeper (more negative) → lower arousal-ish → invert mildly
    return Math.max(0, Math.min(100, 50 - raw * 8))
  }

  if (
    featureId === 'petrosian_fd' ||
    featureId === 'higuchi_fd' ||
    featureId === 'katz_fd' ||
    featureId === 'hjorth_complexity' ||
    featureId === 'hjorth_mobility' ||
    featureId === 'hjorth_mobility_spect' ||
    featureId === 'hjorth_complexity_spect'
  ) {
    // FD ~1–2, Hjorth complexity often ~1–2+
    return Math.max(0, Math.min(100, ((raw - 1) / 1.2) * 100))
  }

  if (featureId.startsWith('rel_power_')) {
    const pct = Math.max(0, Math.min(100, raw * 100 * 2.2))
    if (featureId === 'rel_power_alpha') return Math.max(0, Math.min(100, 100 - pct))
    return pct
  }

  if (featureId === 'pow_freq_bands') {
    // raw already β/α from resolveDriverRaw
    return softScore(raw, 1) * 1.15
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
    const soft = softScore(raw, featureId === 'cognitive_load' || featureId === 'drowsiness' ? 1.2 : 1)
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
  const span = state.max - state.min
  if (span < 4) {
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

/** Default control driver: S-tier rms. */
export const DEFAULT_STRESS_DRIVER = 'rms'

export function loadStressDriver(): string {
  try {
    const v = localStorage.getItem(STRESS_DRIVER_STORAGE_KEY)
    if (v && CONTROL_SIGNAL_OPTIONS.some((o) => o.id === v)) return v
  } catch {
    /* ignore */
  }
  return DEFAULT_STRESS_DRIVER
}

export function saveStressDriver(id: string): void {
  localStorage.setItem(STRESS_DRIVER_STORAGE_KEY, id)
}

export function ema(prev: number, next: number, alpha = 0.18): number {
  return prev * (1 - alpha) + next * alpha
}
