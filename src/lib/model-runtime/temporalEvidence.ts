import type { ModelPrediction } from './contracts'

const LOG_EPS = 1e-12
const STORAGE_KEY = 'passive-bci.smr-temporal-filter'

export type TemporalFilterMode = 'raw' | 'ema' | 'window' | 'hmm'

export type TemporalFilterConfig = {
  mode: TemporalFilterMode
  /** EMA mixing weight on the current window. 0.2 → 20% now, 80% history. */
  alpha: number
  /** HMM self-transition. 0.95 → intent rarely jumps in 100 ms. */
  stayProb: number
  /** Softmax temperature. >1 flattens overconfident heads before accumulation. */
  temperature: number
  /** Finite evidence horizon for mean-logit pooling. */
  horizonSec: number
  /** Decode hop used to convert horizonSec → window count. */
  stepSec: number
}

export const DEFAULT_TEMPORAL_FILTER: TemporalFilterConfig = {
  mode: 'ema',
  alpha: 0.2,
  stayProb: 0.95,
  temperature: 1.5,
  horizonSec: 1,
  stepSec: 0.1,
}

export type TemporalObservation = {
  observationId: string
  segmentId?: string
  classNames: readonly string[]
  probabilities: readonly number[]
  logits?: readonly number[]
}

export type TemporalDecision = {
  classId: number
  className: string
  classNames: string[]
  probabilities: number[]
  logits: number[]
  confidence: number
  rawClassId: number
  rawClassName: string
  observationId: string
}

export function softmax(logits: readonly number[]): number[] {
  if (logits.length === 0) return []
  let max = -Infinity
  for (const z of logits) if (z > max) max = z
  const exps = logits.map((z) => Math.exp(z - max))
  let sum = 0
  for (const e of exps) sum += e
  const denom = sum > 0 ? sum : 1
  return exps.map((e) => e / denom)
}

export function logitsFromProbabilities(probs: readonly number[]): number[] {
  const logs = probs.map((p) => Math.log(Math.max(LOG_EPS, p)))
  const mean = logs.reduce((a, b) => a + b, 0) / Math.max(1, logs.length)
  return logs.map((z) => z - mean)
}

export function applyTemperature(logits: readonly number[], temperature: number): number[] {
  const t = Math.max(0.05, temperature)
  return logits.map((z) => z / t)
}

export function argmax(values: readonly number[]): number {
  let best = 0
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? -Infinity) > (values[best] ?? -Infinity)) best = i
  }
  return best
}

export function horizonWindows(config: TemporalFilterConfig): number {
  return Math.max(1, Math.round(config.horizonSec / Math.max(1e-6, config.stepSec)))
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

function meanRows(rows: readonly number[][]): number[] {
  const n = rows[0]?.length ?? 0
  const out = new Array<number>(n).fill(0)
  if (!rows.length || n === 0) return out
  for (const row of rows) {
    for (let i = 0; i < n; i++) out[i]! += row[i] ?? 0
  }
  const inv = 1 / rows.length
  for (let i = 0; i < n; i++) out[i]! *= inv
  return out
}

function hmmForward(
  prev: readonly number[],
  emission: readonly number[],
  stayProb: number,
): number[] {
  const k = emission.length
  if (k === 0) return []
  const stay = Math.min(0.999, Math.max(0.01, stayProb))
  const jump = k > 1 ? (1 - stay) / (k - 1) : 0
  const predicted = new Array<number>(k).fill(0)
  for (let from = 0; from < k; from++) {
    const mass = prev[from] ?? 0
    for (let to = 0; to < k; to++) {
      predicted[to]! += mass * (from === to ? stay : jump)
    }
  }
  const unnorm = predicted.map((p, i) => p * Math.max(LOG_EPS, emission[i] ?? 0))
  return softmax(unnorm.map(Math.log))
}

export class TemporalEvidenceFilter {
  private config: TemporalFilterConfig
  private classNames: string[] = []
  private emaLogits: number[] | null = null
  private hmmPost: number[] | null = null
  private logitHistory: number[][] = []
  private lastObservationId: string | null = null
  private lastSegmentId: string | undefined
  private lastDecision: TemporalDecision | null = null

  constructor(config: TemporalFilterConfig = DEFAULT_TEMPORAL_FILTER) {
    this.config = { ...DEFAULT_TEMPORAL_FILTER, ...config }
  }

  get snapshot(): TemporalDecision | null {
    return this.lastDecision
  }

  setConfig(config: TemporalFilterConfig): void {
    const prev = this.config
    this.config = { ...DEFAULT_TEMPORAL_FILTER, ...config }
    if (prev.mode !== this.config.mode) this.reset()
  }

  reset(): void {
    this.emaLogits = null
    this.hmmPost = null
    this.logitHistory = []
    this.lastObservationId = null
    this.lastSegmentId = undefined
    this.lastDecision = null
    this.classNames = []
  }

  observePrediction(prediction: ModelPrediction): TemporalDecision {
    return this.observe({
      observationId: prediction.observation_id,
      segmentId: prediction.segment_id,
      classNames: prediction.class_names,
      probabilities: prediction.probabilities,
      logits: prediction.logits,
    })
  }

  observe(input: TemporalObservation): TemporalDecision {
    if (
      this.lastDecision &&
      input.observationId === this.lastObservationId &&
      sameNames(input.classNames, this.classNames)
    ) {
      return this.lastDecision
    }
    if (
      (input.segmentId && this.lastSegmentId && input.segmentId !== this.lastSegmentId) ||
      (this.classNames.length > 0 && !sameNames(input.classNames, this.classNames))
    ) {
      this.reset()
    }

    const classNames = [...input.classNames]
    const rawLogits =
      input.logits?.length === classNames.length
        ? [...input.logits]
        : logitsFromProbabilities(input.probabilities)
    const z = applyTemperature(rawLogits, this.config.temperature)
    const rawProbs = softmax(z)
    const rawClassId = argmax(rawProbs)
    const nKeep = horizonWindows(this.config)

    this.classNames = classNames
    this.lastObservationId = input.observationId
    this.lastSegmentId = input.segmentId
    this.logitHistory.push(z)
    while (this.logitHistory.length > Math.max(nKeep, 48)) this.logitHistory.shift()

    let outLogits: number[]
    let outProbs: number[]
    const mode = this.config.mode

    if (mode === 'ema') {
      const alpha = Math.min(1, Math.max(0.01, this.config.alpha))
      this.emaLogits =
        this.emaLogits == null
          ? [...z]
          : this.emaLogits.map((s, i) => (1 - alpha) * s + alpha * (z[i] ?? 0))
      outLogits = this.emaLogits
      outProbs = softmax(outLogits)
    } else if (mode === 'window') {
      outLogits = meanRows(this.logitHistory.slice(-nKeep))
      outProbs = softmax(outLogits)
    } else if (mode === 'hmm') {
      this.hmmPost =
        this.hmmPost == null
          ? [...rawProbs]
          : hmmForward(this.hmmPost, rawProbs, this.config.stayProb)
      outProbs = this.hmmPost
      outLogits = logitsFromProbabilities(outProbs)
    } else {
      outLogits = z
      outProbs = rawProbs
    }

    const classId = argmax(outProbs)
    const decision: TemporalDecision = {
      classId,
      className: classNames[classId] ?? '',
      classNames,
      probabilities: outProbs,
      logits: outLogits,
      confidence: outProbs[classId] ?? 0,
      rawClassId,
      rawClassName: classNames[rawClassId] ?? '',
      observationId: input.observationId,
    }
    this.lastDecision = decision
    return decision
  }
}

export function predictionFromDecision(
  source: ModelPrediction,
  decision: TemporalDecision,
): ModelPrediction {
  return {
    ...source,
    class_id: decision.classId,
    class_name: decision.className,
    probabilities: decision.probabilities,
    logits: decision.logits,
    confidence: decision.confidence,
  }
}

export type LabeledWindow = {
  probabilities: number[]
  label: number
  classNames?: string[]
}

/** Rolling mean-logit accuracy; only scores steps whose last `n` true labels agree. */
export function rollingMeanLogitAccuracy(sequence: readonly LabeledWindow[], n: number): number {
  const size = Math.max(1, Math.round(n))
  let hits = 0
  let total = 0
  for (let i = size - 1; i < sequence.length; i++) {
    const block = sequence.slice(i - size + 1, i + 1)
    const label = block[0]!.label
    if (block.some((row) => row.label !== label)) continue
    const logits = block.map((row) => logitsFromProbabilities(row.probabilities))
    const classId = argmax(softmax(meanRows(logits)))
    if (classId === label) hits += 1
    total += 1
  }
  return total === 0 ? 0 : hits / total
}

export function filterSequenceAccuracy(
  sequence: readonly LabeledWindow[],
  config: TemporalFilterConfig,
): number {
  const filter = new TemporalEvidenceFilter(config)
  const names = sequence[0]?.classNames ?? sequence[0]?.probabilities.map((_, i) => String(i)) ?? []
  let hits = 0
  for (let i = 0; i < sequence.length; i++) {
    const row = sequence[i]!
    const decision = filter.observe({
      observationId: String(i),
      classNames: row.classNames ?? names,
      probabilities: row.probabilities,
    })
    if (decision.classId === row.label) hits += 1
  }
  return sequence.length === 0 ? 0 : hits / sequence.length
}

export function loadTemporalFilterConfig(): TemporalFilterConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_TEMPORAL_FILTER }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_TEMPORAL_FILTER }
    const parsed = JSON.parse(raw) as Partial<TemporalFilterConfig>
    const mode = parsed.mode
    return {
      ...DEFAULT_TEMPORAL_FILTER,
      ...parsed,
      mode: mode === 'raw' || mode === 'ema' || mode === 'window' || mode === 'hmm' ? mode : 'ema',
      alpha: Number.isFinite(parsed.alpha) ? Number(parsed.alpha) : DEFAULT_TEMPORAL_FILTER.alpha,
      stayProb: Number.isFinite(parsed.stayProb)
        ? Number(parsed.stayProb)
        : DEFAULT_TEMPORAL_FILTER.stayProb,
      temperature: Number.isFinite(parsed.temperature)
        ? Number(parsed.temperature)
        : DEFAULT_TEMPORAL_FILTER.temperature,
      horizonSec: Number.isFinite(parsed.horizonSec)
        ? Number(parsed.horizonSec)
        : DEFAULT_TEMPORAL_FILTER.horizonSec,
      stepSec: Number.isFinite(parsed.stepSec)
        ? Number(parsed.stepSec)
        : DEFAULT_TEMPORAL_FILTER.stepSec,
    }
  } catch {
    return { ...DEFAULT_TEMPORAL_FILTER }
  }
}

export function saveTemporalFilterConfig(config: TemporalFilterConfig): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
