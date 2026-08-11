/** Feature catalog aligned with Downloads/epoch_feature_extraction.py DEFAULT_FEATURES. */

export type FeatureGroupId =
  | 'time'
  | 'hjorth'
  | 'spectral'
  | 'entropy'
  | 'fractal'
  | 'scores'

export interface FeatureDef {
  id: string
  label: string
  group: FeatureGroupId
  /** Expensive for real-time; default off. */
  heavy?: boolean
  /** Multi-value feature expands into these display keys. */
  expandsTo?: string[]
  format?: 'raw' | 'percent' | 'uV' | 'ratio' | 'score'
}

export const FEATURE_GROUPS: { id: FeatureGroupId; label: string }[] = [
  { id: 'time', label: '时域' },
  { id: 'hjorth', label: 'Hjorth' },
  { id: 'spectral', label: '频谱 / 频带' },
  { id: 'entropy', label: '熵 / 复杂度' },
  { id: 'fractal', label: '分形 / 非线性' },
  { id: 'scores', label: '派生评分' },
]

export const FREQ_BANDS = {
  delta: [1, 4] as const,
  theta: [4, 8] as const,
  alpha: [8, 13] as const,
  beta: [13, 30] as const,
  gamma: [30, 45] as const,
  gamma_plus: [45, 80] as const,
} as const

export type BandName = keyof typeof FREQ_BANDS

export const BAND_NAMES = Object.keys(FREQ_BANDS) as BandName[]

const REL_POWER_KEYS = BAND_NAMES.map((b) => `rel_power_${b}`)
const ENERGY_KEYS = BAND_NAMES.map((b) => `energy_${b}`)

/** Same set as offline DEFAULT_FEATURES (+ neuroskill-like scores). */
export const FEATURE_CATALOG: FeatureDef[] = [
  { id: 'mean', label: 'mean', group: 'time', format: 'uV' },
  { id: 'std', label: 'std', group: 'time', format: 'uV' },
  { id: 'variance', label: 'variance', group: 'time', format: 'raw' },
  { id: 'rms', label: 'rms', group: 'time', format: 'uV' },
  { id: 'ptp_amp', label: 'ptp_amp', group: 'time', format: 'uV' },
  { id: 'skewness', label: 'skewness', group: 'time', format: 'raw' },
  { id: 'kurtosis', label: 'kurtosis', group: 'time', format: 'raw' },
  { id: 'line_length', label: 'line_length', group: 'time', format: 'raw' },
  { id: 'zero_crossings', label: 'zero_crossings', group: 'time', format: 'raw' },

  { id: 'hjorth_mobility', label: 'hjorth_mobility', group: 'hjorth', format: 'raw' },
  { id: 'hjorth_complexity', label: 'hjorth_complexity', group: 'hjorth', format: 'raw' },
  { id: 'hjorth_mobility_spect', label: 'hjorth_mobility_spect', group: 'hjorth', format: 'raw' },
  { id: 'hjorth_complexity_spect', label: 'hjorth_complexity_spect', group: 'hjorth', format: 'raw' },

  {
    id: 'pow_freq_bands',
    label: 'pow_freq_bands (rel)',
    group: 'spectral',
    expandsTo: REL_POWER_KEYS,
    format: 'percent',
  },
  {
    id: 'energy_freq_bands',
    label: 'energy_freq_bands',
    group: 'spectral',
    expandsTo: ENERGY_KEYS,
    format: 'raw',
  },
  { id: 'spect_entropy', label: 'spect_entropy', group: 'spectral', format: 'percent' },
  { id: 'spect_slope', label: 'spect_slope', group: 'spectral', format: 'raw' },
  { id: 'spect_edge_freq', label: 'spect_edge_freq', group: 'spectral', format: 'raw' },
  { id: 'teager_kaiser_energy', label: 'teager_kaiser_energy', group: 'spectral', format: 'raw' },

  { id: 'svd_entropy', label: 'svd_entropy', group: 'entropy', heavy: true, format: 'percent' },
  { id: 'svd_fisher_info', label: 'svd_fisher_info', group: 'entropy', heavy: true, format: 'raw' },
  { id: 'app_entropy', label: 'app_entropy', group: 'entropy', heavy: true, format: 'raw' },
  { id: 'samp_entropy', label: 'samp_entropy', group: 'entropy', heavy: true, format: 'raw' },
  { id: 'perm_entropy', label: 'perm_entropy', group: 'entropy', format: 'percent' },

  { id: 'hurst_exp', label: 'hurst_exp', group: 'fractal', heavy: true, format: 'raw' },
  { id: 'higuchi_fd', label: 'higuchi_fd', group: 'fractal', heavy: true, format: 'raw' },
  { id: 'katz_fd', label: 'katz_fd', group: 'fractal', format: 'raw' },
  { id: 'petrosian_fd', label: 'petrosian_fd', group: 'fractal', format: 'raw' },
  { id: 'dfa_exponent', label: 'dfa_exponent', group: 'fractal', heavy: true, format: 'raw' },
  { id: 'lziv_complexity', label: 'lziv_complexity', group: 'fractal', heavy: true, format: 'percent' },

  { id: 'focus_score', label: 'focus_score', group: 'scores', format: 'score' },
  { id: 'engagement_score', label: 'engagement_score', group: 'scores', format: 'score' },
  { id: 'relaxation_score', label: 'relaxation_score', group: 'scores', format: 'score' },
  { id: 'cognitive_load', label: 'cognitive_load', group: 'scores', format: 'score' },
  { id: 'drowsiness', label: 'drowsiness', group: 'scores', format: 'score' },
  { id: 'tbr_theta_beta', label: 'θ/β', group: 'scores', format: 'ratio' },
  { id: 'tar_theta_alpha', label: 'θ/α', group: 'scores', format: 'ratio' },
  { id: 'bar_beta_alpha', label: 'β/α', group: 'scores', format: 'ratio' },
]

/** Shared across acquisition + all experiment pages. */
export const FEATURE_STORAGE_KEY = 'passive-bci.feature-selection'
/** Legacy key from acquisition-only era. */
const FEATURE_STORAGE_KEY_LEGACY = 'passive-bci.acquisition.feature-selection'

/** Lightweight defaults: all non-heavy features on. */
export function defaultEnabledFeatures(): string[] {
  return FEATURE_CATALOG.filter((f) => !f.heavy).map((f) => f.id)
}

export function loadEnabledFeatures(): string[] {
  try {
    const raw =
      localStorage.getItem(FEATURE_STORAGE_KEY) ??
      localStorage.getItem(FEATURE_STORAGE_KEY_LEGACY)
    if (!raw) return defaultEnabledFeatures()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return defaultEnabledFeatures()
    const valid = new Set(FEATURE_CATALOG.map((f) => f.id))
    const ids = parsed.filter((x): x is string => typeof x === 'string' && valid.has(x))
    return ids.length ? ids : defaultEnabledFeatures()
  } catch {
    return defaultEnabledFeatures()
  }
}

export function saveEnabledFeatures(ids: string[]): void {
  localStorage.setItem(FEATURE_STORAGE_KEY, JSON.stringify(ids))
}

export function displayKeysForEnabled(enabled: Set<string> | string[]): string[] {
  const set = enabled instanceof Set ? enabled : new Set(enabled)
  const keys: string[] = []
  for (const f of FEATURE_CATALOG) {
    if (!set.has(f.id)) continue
    if (f.expandsTo?.length) keys.push(...f.expandsTo)
    else keys.push(f.id)
  }
  return keys
}

export function formatFeatureValue(
  key: string,
  value: number,
  formatHint?: FeatureDef['format'],
): string {
  if (!Number.isFinite(value)) return '—'
  const def =
    FEATURE_CATALOG.find((f) => f.id === key) ||
    FEATURE_CATALOG.find((f) => f.expandsTo?.includes(key))
  const fmt = formatHint ?? def?.format ?? 'raw'
  switch (fmt) {
    case 'percent':
      return key.startsWith('rel_power_') || key === 'spect_entropy' || key === 'perm_entropy' || key === 'lziv_complexity'
        ? `${(value * 100).toFixed(1)}%`
        : `${value.toFixed(3)}`
    case 'uV':
      return `${value.toFixed(2)} μV`
    case 'score':
      return `${softScore(value).toFixed(0)}`
    case 'ratio':
      return value.toFixed(2)
    default:
      return Math.abs(value) >= 1000 || (Math.abs(value) > 0 && Math.abs(value) < 0.01)
        ? value.toExponential(2)
        : value.toFixed(3)
  }
}

/** Soft-map unbounded ratios into 0–100 display scores. */
export function softScore(raw: number, scale = 1): number {
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.min(100, (raw / (raw + scale)) * 100))
}

export function labelForDisplayKey(key: string): string {
  if (key.startsWith('rel_power_')) return key.replace('rel_power_', 'rel ')
  if (key.startsWith('energy_')) return key
  const def = FEATURE_CATALOG.find((f) => f.id === key)
  return def?.label ?? key
}
