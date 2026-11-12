import { mulberry32, shuffleInPlace } from '../../lib/rng'
import { resolveChannelMaskInput } from '../../lib/eeg/liveHub'

export type FocusLabel = 'relax' | 'focus'
export type FocusPhase = 'prepare' | 'cue' | 'collect' | 'recovery'
export type FocusConfig = { trials: number; prepareSec: number; cueSec: number; collectSec: number; recoverySec: number }
export const DEFAULT_FOCUS_CONFIG: FocusConfig = { trials: 20, prepareSec: 2, cueSec: 1, collectSec: 4, recoverySec: 3 }
export const FOCUS_CLASSES = { relax: 0, focus: 1 } as const

export function validateFocusConfig(config: FocusConfig): void {
  if (!Number.isInteger(config.trials) || config.trials < 2 || config.trials > 200 || config.trials % 2) {
    throw new Error('试次数必须为 2–200 的偶数')
  }
  for (const value of [config.prepareSec, config.cueSec, config.collectSec, config.recoverySec]) {
    if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error('各阶段时长必须为 1–10 秒')
  }
}

export function createFocusPlan(config: FocusConfig, seed: number): FocusLabel[] {
  validateFocusConfig(config)
  const rng = mulberry32(seed)
  const plan: FocusLabel[] = []
  // Balance short blocks as well as the whole session.
  while (plan.length < config.trials) {
    const remaining = Math.min(4, config.trials - plan.length)
    const block: FocusLabel[] = Array.from({ length: remaining }, (_, i) => i % 2 ? 'focus' : 'relax')
    plan.push(...shuffleInPlace(block, rng))
  }
  return plan
}

export function focusPhaseDuration(config: FocusConfig, phase: FocusPhase): number {
  return config[`${phase}Sec`]
}

/**
 * Resolve a free-form channel list (names or numbers, e.g. "CH1 9 16") into a
 * boolean mask aligned to `channelNames`. Numbers match a `CH<n>` name first,
 * then fall back to 1-based indices. Returns null mask when unrestricted.
 */
export function resolveFocusChannels(input: string, channelNames: string[]): { mask: boolean[] | null; matched: number[]; missing: string[] } {
  return resolveChannelMaskInput(input, channelNames)
}

export function focusInterval(start: number | null, end: number | null, sampleRate: number, expectedSec: number,
  reason: string | null, preview: boolean) {
  const invalid = reason ?? (preview ? 'preview' : start === null || end === null || !Number.isFinite(start)
    || !Number.isFinite(end) || !Number.isFinite(sampleRate) || sampleRate <= 0 ? 'sample_clock_unavailable'
    : end <= start || end - start < sampleRate * expectedSec * .8 || end - start > sampleRate * expectedSec * 1.2
      ? 'sample_clock_discontinuity' : null)
  return { sampleStart: start, sampleEnd: end, sampleRate, valid: invalid === null, invalidReason: invalid,
    sampleIndexScope: 'stream', sampleEndExclusive: true }
}
