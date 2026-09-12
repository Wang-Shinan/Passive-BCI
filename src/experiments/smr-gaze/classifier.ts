import { mulberry32, shuffleInPlace } from '../../lib/rng'

export const DIRECTIONS = ['left', 'right', 'up', 'down'] as const
export type Direction = typeof DIRECTIONS[number]
export const DIRECTION_NAMES: Record<Direction, string> = { left: '左', right: '右', up: '上', down: '下' }
export const BASELINE_SEC = 2
export const TARGET_SEC = 3
export type GazeTrial = { index: number; run: number; target: Direction }
export type Example = GazeTrial & { features: number[] }
export type GazeModel = {
  version: 1
  kind: 'eeg-gaze-regularized-diagonal-lda'
  subjectId: string
  channels: string[]
  sampleRate: number
  createdAt: string
  means: number[][]
  variance: number[]
  counts: number[]
}

export function makePlan(seed: number, runs = 3): GazeTrial[] {
  const rng = mulberry32(seed)
  const trials: GazeTrial[] = []
  for (let run = 1; run <= runs; run++) {
    // Balance all four directions within every run; avoid LR/UD block confounding.
    const targets = shuffleInPlace(Array.from({ length: 4 }, () => [...DIRECTIONS]).flat(), rng)
    for (const target of targets) trials.push({ index: trials.length, run, target })
  }
  return trials
}

function trimmedMean(values: Float32Array): number {
  if (!values.length || !values.every(Number.isFinite)) throw new Error('EEG 窗口为空或包含无效数值')
  const sorted = Array.from(values).sort((a, b) => a - b)
  const trim = Math.floor(sorted.length * 0.1)
  const kept = sorted.slice(trim, sorted.length - trim)
  return kept.reduce((a, b) => a + b, 0) / kept.length
}

/** Signed low-frequency potentials relative to the preceding central fixation.
 * Three temporal bins retain the saccade transient as well as sustained offsets.
 * This deliberately uses raw EEG, not the SMR mu-band feature pipeline.
 */
export function gazeFeatures(baseline: Float32Array[], target: Float32Array[], hz: number): number[] {
  if (!Number.isFinite(hz) || hz < 20 || !baseline.length || baseline.length !== target.length) {
    throw new Error('采样率或通道不匹配')
  }
  return baseline.flatMap((base, ch) => {
    const trace = target[ch]!
    if (base.length < Math.round(hz) || trace.length < Math.round(TARGET_SEC * hz)) {
      throw new Error('EEG 窗口不足')
    }
    const center = trimmedMean(base)
    return [[0.15, 0.8], [0.8, 1.6], [1.6, 2.6]].map(([start, end]) =>
      trimmedMean(trace.slice(Math.round(start! * hz), Math.round(end! * hz))) - center,
    )
  })
}

export function fitGazeModel(examples: Example[], subjectId: string, channels: string[], sampleRate: number): GazeModel {
  const dim = channels.length * 3
  if (!dim || examples.some((e) => e.features.length !== dim || !e.features.every(Number.isFinite))) {
    throw new Error('训练特征维度或数值无效')
  }
  const groups = DIRECTIONS.map((target) => examples.filter((e) => e.target === target))
  if (groups.some((g) => g.length < 3)) throw new Error('每个方向至少需要 3 个有效试次，请重新采集')
  const means = groups.map((g) => Array.from({ length: dim }, (_, j) =>
    g.reduce((sum, e) => sum + e.features[j]!, 0) / g.length,
  ))
  const rawVariance = Array.from({ length: dim }, (_, j) => groups.reduce((sum, g, c) =>
    sum + g.reduce((s, e) => s + (e.features[j]! - means[c]![j]!) ** 2, 0), 0,
  ) / Math.max(1, examples.length - DIRECTIONS.length))
  const average = rawVariance.reduce((a, b) => a + b, 0) / dim
  // Fixed shrinkage + a 1 uV² floor prevents nearly flat channels dominating.
  const variance = rawVariance.map((v) => Math.max(1, 0.8 * v + 0.2 * average))
  return {
    version: 1, kind: 'eeg-gaze-regularized-diagonal-lda', subjectId, channels: [...channels],
    sampleRate, createdAt: new Date().toISOString(), means, variance, counts: groups.map((g) => g.length),
  }
}

export function predictGaze(model: GazeModel, features: number[]): Direction {
  if (features.length !== model.variance.length || !features.every(Number.isFinite)) throw new Error('预测特征无效')
  // Equal class priors: rejected trials must not bias direction prevalence.
  const scores = model.means.map((mean) => mean.reduce((sum, value, j) =>
    sum + (features[j]! * value - 0.5 * value * value) / model.variance[j]!, 0,
  ))
  return DIRECTIONS[scores.indexOf(Math.max(...scores))]!
}

export function evaluateGaze(model: GazeModel, examples: Example[]) {
  const confusion = DIRECTIONS.map(() => DIRECTIONS.map(() => 0))
  for (const example of examples) {
    confusion[DIRECTIONS.indexOf(example.target)]![DIRECTIONS.indexOf(predictGaze(model, example.features))]! += 1
  }
  const recalls = confusion.map((row, i) => row.reduce((a, b) => a + b, 0) ? row[i]! / row.reduce((a, b) => a + b, 0) : null)
  return {
    n: examples.length, confusion, recalls,
    balancedAccuracy: recalls.every((r) => r !== null) ? recalls.reduce((a, b) => a + b, 0) / 4 : null,
  }
}

export function parseGazeModel(raw: string | null): GazeModel | null {
  try {
    const m = JSON.parse(raw ?? 'null') as GazeModel | null
    if (!m || m.version !== 1 || m.kind !== 'eeg-gaze-regularized-diagonal-lda' || typeof m.subjectId !== 'string'
      || !Array.isArray(m.channels) || !m.channels.length || !m.channels.every((c) => typeof c === 'string')
      || !Number.isFinite(m.sampleRate) || m.sampleRate < 20 || !Array.isArray(m.variance)
      || m.variance.length !== m.channels.length * 3 || !m.variance.every((v) => Number.isFinite(v) && v > 0)
      || !Array.isArray(m.means) || m.means.length !== 4
      || !m.means.every((row) => Array.isArray(row) && row.length === m.variance.length && row.every(Number.isFinite))
      || !Array.isArray(m.counts) || m.counts.length !== 4 || !m.counts.every((n) => Number.isInteger(n) && n >= 3)) return null
    return m
  } catch { return null }
}
