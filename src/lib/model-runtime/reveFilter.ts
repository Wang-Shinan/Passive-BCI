export const REVE_FILTER_LABELS = {
  pretraining: '0.5–99.5 Hz + 50/100 Hz 陷波（默认）',
  none: '不滤波',
  checkpoint: '按权重配置',
  custom: '自定义',
} as const

export type ReveFilterMode = keyof typeof REVE_FILTER_LABELS
export const DEFAULT_REVE_FILTER: ReveFilterMode = 'pretraining'
export type ReveCustomFilter = { lowHz: number; highHz: number; useNotch: boolean }
export type ReveFilterSettings = { reveFilterMode: ReveFilterMode; reveCustomFilter?: ReveCustomFilter }
export const DEFAULT_REVE_BAND: ReveCustomFilter = { lowHz: 0.5, highHz: 99.5, useNotch: true }
export const S04_REVE_BAND: ReveCustomFilter = { lowHz: 0.5, highHz: 40, useNotch: true }
export const REVE_FILTER_STORAGE_KEY = 'passive-bci.eeg-filter'
const LEGACY_MODE_KEY = 'passive-bci.reve-filter-mode'

export function isReveFilterMode(value: unknown): value is ReveFilterMode {
  return typeof value === 'string' && Object.hasOwn(REVE_FILTER_LABELS, value)
}

export function parseReveCustomFilter(value: unknown): ReveCustomFilter | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { lowHz, highHz, useNotch } = value as Partial<ReveCustomFilter>
  if (typeof lowHz !== 'number' || !Number.isFinite(lowHz) || lowHz < 0.05 || lowHz > 30
    || typeof highHz !== 'number' || !Number.isFinite(highHz) || highHz < lowHz + 0.5 || highHz > DEFAULT_REVE_BAND.highHz
    || typeof useNotch !== 'boolean') return undefined
  return { lowHz, highHz, useNotch }
}

export function sameReveCustomFilter(a?: ReveCustomFilter | null, b?: ReveCustomFilter | null): boolean {
  return a?.lowHz === b?.lowHz && a?.highHz === b?.highHz && a?.useNotch === b?.useNotch
}

export function loadReveFilterSettings(): ReveFilterSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(REVE_FILTER_STORAGE_KEY) || '{}')
    const value = stored?.reveFilterMode ?? localStorage.getItem(LEGACY_MODE_KEY)
    const reveCustomFilter = parseReveCustomFilter(stored?.reveCustomFilter)
    if (isReveFilterMode(value) && (value !== 'custom' || reveCustomFilter)) {
      return { reveFilterMode: value, reveCustomFilter }
    }
  } catch { /* Storage may be unavailable. */ }
  return { reveFilterMode: DEFAULT_REVE_FILTER }
}

export function saveReveFilterSettings(settings: ReveFilterSettings): void {
  try { localStorage.setItem(REVE_FILTER_STORAGE_KEY, JSON.stringify(settings)) }
  catch { /* The current selection still applies. */ }
}

export function describeReveFilter(mode: ReveFilterMode, band?: ReveCustomFilter): string {
  if (mode === 'checkpoint') return '0.5–40 Hz 带通 + 50 Hz 陷波'
  if (band) {
    return `${band.lowHz}–${band.highHz} Hz 带通${band.useNotch ? ' + 工频陷波' : ''}`
  }
  if (mode === 'pretraining') return '0.5–99.5 Hz 带通'
  return REVE_FILTER_LABELS[mode]
}
