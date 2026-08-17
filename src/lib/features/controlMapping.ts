/** Map live feature scalars → 0–100 control channels. */

import { softScore } from './featureCatalog'

export type SignalControlMode = 'manual' | 'features' | 'live'

export function isFeatureDriven(mode: SignalControlMode): boolean {
  return mode === 'features' || mode === 'live'
}

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

/** Panel already shows these as softScore 0–100. */
export function isPanelScoreDriver(featureId: string): boolean {
  return (
    featureId.endsWith('_score') ||
    featureId === 'cognitive_load' ||
    featureId === 'drowsiness'
  )
}

export const FEATURE_RANGE_STORAGE_KEY = 'passive-bci.feature-range-maps'

/** Linear map: feature display value in [inMin, inMax] → difficulty [outMin, outMax]. */
export type FeatureRangeMap = {
  inMin: number
  inMax: number
  outMin: number
  outMax: number
}

export function defaultRangeForDriver(featureId: string): FeatureRangeMap {
  if (featureId === DEMO_ENVELOPE_DRIVER || isPanelScoreDriver(featureId)) {
    return { inMin: 0, inMax: 100, outMin: 0, outMax: 100 }
  }
  if (featureId === 'rel_power_alpha') return { inMin: 35, inMax: 10, outMin: 0, outMax: 100 }
  if (featureId.startsWith('rel_power_')) return { inMin: 10, inMax: 40, outMin: 0, outMax: 100 }
  if (featureId === 'pow_freq_bands') return { inMin: 0.3, inMax: 2, outMin: 0, outMax: 100 }
  if (featureId === 'rms' || featureId === 'std') return { inMin: 5, inMax: 40, outMin: 0, outMax: 100 }
  if (featureId === 'ptp_amp') return { inMin: 10, inMax: 80, outMin: 0, outMax: 100 }
  if (featureId === 'line_length') return { inMin: 20, inMax: 250, outMin: 0, outMax: 100 }
  if (featureId === 'teager_kaiser_energy') return { inMin: 0, inMax: 200, outMin: 0, outMax: 100 }
  if (featureId === 'energy_freq_bands' || featureId.startsWith('energy_')) {
    return { inMin: 50, inMax: 5000, outMin: 0, outMax: 100 }
  }
  if (featureId === 'petrosian_fd') return { inMin: 1.45, inMax: 1.65, outMin: 0, outMax: 100 }
  if (featureId === 'higuchi_fd') return { inMin: 1.2, inMax: 1.8, outMin: 0, outMax: 100 }
  if (featureId === 'perm_entropy' || featureId === 'spect_entropy' || featureId === 'lziv_complexity') {
    return { inMin: 40, inMax: 90, outMin: 0, outMax: 100 }
  }
  if (featureId === 'spect_slope') return { inMin: -2.5, inMax: 0, outMin: 0, outMax: 100 }
  if (featureId === 'hjorth_complexity') return { inMin: 1.15, inMax: 2, outMin: 0, outMax: 100 }
  if (featureId === 'hjorth_mobility_spect' || featureId === 'hjorth_complexity_spect') {
    return { inMin: 0.5, inMax: 2, outMin: 0, outMax: 100 }
  }
  return { inMin: 0, inMax: 100, outMin: 0, outMax: 100 }
}

function isRangeMap(x: unknown): x is FeatureRangeMap {
  if (!x || typeof x !== 'object') return false
  const r = x as FeatureRangeMap
  return [r.inMin, r.inMax, r.outMin, r.outMax].every((v) => typeof v === 'number' && Number.isFinite(v))
}

export function loadRangeMap(featureId: string): FeatureRangeMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(FEATURE_RANGE_STORAGE_KEY) ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') {
      const hit = (parsed as Record<string, unknown>)[featureId]
      if (isRangeMap(hit)) return hit
    }
  } catch {
    /* ignore */
  }
  return defaultRangeForDriver(featureId)
}

export function saveRangeMap(featureId: string, range: FeatureRangeMap): void {
  let all: Record<string, FeatureRangeMap> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(FEATURE_RANGE_STORAGE_KEY) ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') all = parsed as Record<string, FeatureRangeMap>
  } catch {
    /* ignore */
  }
  all[featureId] = range
  localStorage.setItem(FEATURE_RANGE_STORAGE_KEY, JSON.stringify(all))
}

/** Same scalar the feature panel shows (softScore / percent×100 / raw). */
export function displayValueForDriver(featureId: string, raw: number): number {
  if (!Number.isFinite(raw)) return NaN
  if (isPanelScoreDriver(featureId)) return softScore(raw)
  if (
    featureId.startsWith('rel_power_') ||
    featureId === 'spect_entropy' ||
    featureId === 'perm_entropy' ||
    featureId === 'lziv_complexity'
  ) {
    return raw * 100
  }
  return raw
}

export function applyRangeMap(x: number, r: FeatureRangeMap): number {
  if (!Number.isFinite(x)) return (r.outMin + r.outMax) / 2
  const span = r.inMax - r.inMin
  if (Math.abs(span) < 1e-12) return (r.outMin + r.outMax) / 2
  const y = r.outMin + ((x - r.inMin) / span) * (r.outMax - r.outMin)
  const lo = Math.min(r.outMin, r.outMax)
  const hi = Math.max(r.outMin, r.outMax)
  return Math.max(lo, Math.min(hi, y))
}

export function roundRangeEdge(v: number): number {
  const a = Math.abs(v)
  if (a >= 100) return Math.round(v)
  if (a >= 10) return Math.round(v * 10) / 10
  return Math.round(v * 100) / 100
}

export type DriverAdaptKind = 'identity' | 'minmax' | 'percentile'

/** Per-driver live adaptation. Control loop ticks at 100 ms. */
export type DriverAdaptProfile = {
  kind: DriverAdaptKind
  windowTicks: number
  floor: number
  ceil: number
  /** 1 = snap to mapped value. */
  ema: number
  minSpan: number
  /** Demo mode: mix synth envelope while observed span is below this. */
  demoFillBelowSpan: number
  percentile?: [number, number]
}

const ADAPT_IDENTITY: DriverAdaptProfile = {
  kind: 'identity',
  windowTicks: 1,
  floor: 0,
  ceil: 100,
  ema: 1,
  minSpan: 100,
  demoFillBelowSpan: 0,
}

/** Amplitude: session-relative, percentile so blinks don't pin the range. */
const ADAPT_AMPLITUDE: DriverAdaptProfile = {
  kind: 'percentile',
  windowTicks: 160,
  floor: 6,
  ceil: 94,
  ema: 0.28,
  minSpan: 8,
  demoFillBelowSpan: 6,
  percentile: [0.1, 0.9],
}

/** Entropy / slope / FD: slower, min–max window. */
const ADAPT_STRUCTURE: DriverAdaptProfile = {
  kind: 'minmax',
  windowTicks: 120,
  floor: 8,
  ceil: 92,
  ema: 0.32,
  minSpan: 5,
  demoFillBelowSpan: 5,
}

/** Hjorth / Higuchi: longer window, heavier smooth. */
const ADAPT_COMPLEXITY: DriverAdaptProfile = {
  kind: 'minmax',
  windowTicks: 200,
  floor: 10,
  ceil: 90,
  ema: 0.2,
  minSpan: 4,
  demoFillBelowSpan: 4,
}

/** Relative bands / ratios: already ~normalized, light stretch. */
const ADAPT_BAND: DriverAdaptProfile = {
  kind: 'minmax',
  windowTicks: 100,
  floor: 12,
  ceil: 88,
  ema: 0.4,
  minSpan: 6,
  demoFillBelowSpan: 5,
}

export function adaptProfileForDriver(featureId: string): DriverAdaptProfile {
  if (featureId === DEMO_ENVELOPE_DRIVER || isPanelScoreDriver(featureId)) {
    return ADAPT_IDENTITY
  }
  if (
    featureId === 'rms' ||
    featureId === 'std' ||
    featureId === 'ptp_amp' ||
    featureId === 'line_length' ||
    featureId === 'teager_kaiser_energy' ||
    featureId === 'energy_freq_bands' ||
    featureId.startsWith('energy_')
  ) {
    return ADAPT_AMPLITUDE
  }
  if (
    featureId.startsWith('rel_power_') ||
    featureId === 'pow_freq_bands' ||
    featureId.startsWith('tbr_') ||
    featureId.startsWith('tar_') ||
    featureId.startsWith('bar_')
  ) {
    return ADAPT_BAND
  }
  if (
    featureId === 'hjorth_complexity' ||
    featureId === 'hjorth_mobility' ||
    featureId === 'hjorth_mobility_spect' ||
    featureId === 'hjorth_complexity_spect' ||
    featureId === 'higuchi_fd'
  ) {
    return ADAPT_COMPLEXITY
  }
  return ADAPT_STRUCTURE
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

  if (isPanelScoreDriver(featureId) || featureId.startsWith('tbr_') || featureId.startsWith('tar_') || featureId.startsWith('bar_')) {
    return softScore(raw, 1)
  }

  return softScore(Math.abs(raw), Math.max(1, Math.abs(raw) * 0.5 + 0.5))
}

export type AdaptiveScaleState = {
  min: number
  max: number
  hist?: number[]
}

function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  const a = sorted[lo]!
  const b = sorted[hi]!
  return lo === hi ? a : a * (hi - i) + b * (i - lo)
}

/** Session-relative rescale. Window / extrema policy comes from the driver profile. */
export function adaptiveScale100(
  mapped: number,
  state: AdaptiveScaleState,
  profile: DriverAdaptProfile,
): number {
  if (!Number.isFinite(mapped)) return 50
  if (profile.kind === 'identity') {
    return Math.max(profile.floor, Math.min(profile.ceil, mapped))
  }
  const hist = state.hist ?? (state.hist = [])
  hist.push(mapped)
  if (hist.length > profile.windowTicks) hist.shift()

  let lo: number
  let hi: number
  if (profile.kind === 'percentile' && hist.length >= 12 && profile.percentile) {
    const sorted = [...hist].sort((a, b) => a - b)
    lo = quantileSorted(sorted, profile.percentile[0])
    hi = quantileSorted(sorted, profile.percentile[1])
  } else {
    lo = hist[0]!
    hi = hist[0]!
    for (let i = 1; i < hist.length; i++) {
      const v = hist[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  state.min = lo
  state.max = hi
  const span = hi - lo
  if (span < profile.minSpan) {
    return Math.max(profile.floor, Math.min(profile.ceil, mapped))
  }
  const t = Math.max(0, Math.min(1, (mapped - lo) / span))
  return profile.floor + t * (profile.ceil - profile.floor)
}

export function loadSignalMode(): SignalControlMode {
  try {
    const v = localStorage.getItem(SIGNAL_MODE_STORAGE_KEY)
    if (v === 'features' || v === 'live' || v === 'manual') return v
  } catch {
    /* ignore */
  }
  return 'manual'
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
