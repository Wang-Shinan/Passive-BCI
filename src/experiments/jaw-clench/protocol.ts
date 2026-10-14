import { mulberry32, shuffleInPlace } from '../../lib/rng'

export type JawLabel = 'relax' | 'clench'
export type JawPhase = 'prepare' | 'cue' | 'collect' | 'recovery'
export type JawConfig = { trials: number; prepareSec: number; cueSec: number; collectSec: number; recoverySec: number }
export const DEFAULT_JAW_CONFIG: JawConfig = { trials: 20, prepareSec: 2, cueSec: 1, collectSec: 2, recoverySec: 3 }
export const JAW_CLASSES = { relax: 0, clench: 1 } as const

export function validateJawConfig(config: JawConfig): void {
  if (!Number.isInteger(config.trials) || config.trials < 2 || config.trials > 200 || config.trials % 2) {
    throw new Error('试次数必须为 2–200 的偶数')
  }
  for (const value of [config.prepareSec, config.cueSec, config.collectSec, config.recoverySec]) {
    if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error('各阶段时长必须为 1–10 秒')
  }
}

export function createJawPlan(config: JawConfig, seed: number): JawLabel[] {
  validateJawConfig(config)
  const rng = mulberry32(seed)
  const plan: JawLabel[] = []
  // Balance short blocks as well as the whole session.
  while (plan.length < config.trials) {
    const remaining = Math.min(4, config.trials - plan.length)
    const block: JawLabel[] = Array.from({ length: remaining }, (_, i) => i % 2 ? 'clench' : 'relax')
    plan.push(...shuffleInPlace(block, rng))
  }
  return plan
}

export function jawPhaseDuration(config: JawConfig, phase: JawPhase): number {
  return config[`${phase}Sec`]
}

export function jawInterval(start: number | null, end: number | null, sampleRate: number, expectedSec: number,
  reason: string | null, preview: boolean) {
  const invalid = reason ?? (preview ? 'preview' : start === null || end === null || !Number.isFinite(start)
    || !Number.isFinite(end) || !Number.isFinite(sampleRate) || sampleRate <= 0 ? 'sample_clock_unavailable'
    : end <= start || end - start < sampleRate * expectedSec * .8 || end - start > sampleRate * expectedSec * 1.2
      ? 'sample_clock_discontinuity' : null)
  return { sampleStart: start, sampleEnd: end, sampleRate, valid: invalid === null, invalidReason: invalid,
    sampleIndexScope: 'stream', sampleEndExclusive: true }
}
