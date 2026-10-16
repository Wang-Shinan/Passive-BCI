import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { DIRECTIONS, type Direction } from './engine'

export type ClassMapping = Record<Direction, string>
export const MI_MAPPING: ClassMapping = { left: 'left_hand', right: 'right_hand', down: 'feet', up: 'tongue' }
// Verified against smr-adapt/labels.ts and model-runtime/reveTasks.ts. Rest is NOT feet.
export const EXISTING_SMR_MAPPING: ClassMapping = { left: 'left_hand', right: 'right_hand', down: 'rest', up: 'tongue' }
export const DIRECTION_MAPPING: ClassMapping = { left: 'left', right: 'right', down: 'down', up: 'up' }
export const MAPPING_PRESETS = { mi: MI_MAPPING, smr: EXISTING_SMR_MAPPING, directions: DIRECTION_MAPPING }
export type MappingPreset = 'auto' | keyof typeof MAPPING_PRESETS | 'custom'
export function mappingForLabels(labels: readonly string[]): ClassMapping | null {
  return Object.values(MAPPING_PRESETS).find(mapping => mappingMatches(labels, mapping)) ?? null
}
export type PredictionFrame = {
  id: string; labels: readonly string[]; probabilities: readonly number[]; receivedAt: number
  /** Optional external trial ID. Must remain fixed throughout ONE independent imagery trial. */
  roundId?: string
}
export function fromModelPrediction(prediction: ModelPrediction): PredictionFrame {
  return { id: prediction.observation_id, labels: prediction.class_names,
    probabilities: prediction.probabilities, receivedAt: prediction.received_at_ms }
}
export type FilterConfig = { threshold: number; stableCount: number; restStableCount: number; releaseThreshold: number; releaseCount: number; maxGapMs: number }
export const DEFAULT_FILTER: FilterConfig = { threshold: .75, stableCount: 3, restStableCount: 3, releaseThreshold: .45, releaseCount: 3, maxGapMs: 1500 }
/** Preserve existing settings and behavior when upgrading a saved pre-rest configuration. */
export function migrateFilterConfig(config: Omit<FilterConfig, 'restStableCount'> & { restStableCount?: number }): FilterConfig {
  const migrated = { ...config, restStableCount: config.restStableCount === undefined ? config.stableCount : config.restStableCount }
  validateConfig(migrated)
  return migrated
}
export function validateConfig(config: FilterConfig): void {
  if (!Number.isFinite(config.threshold) || config.threshold <= .25 || config.threshold > 1 ||
      !Number.isFinite(config.releaseThreshold) || config.releaseThreshold < .25 || config.releaseThreshold >= config.threshold ||
      !Number.isInteger(config.stableCount) || config.stableCount < 1 || config.stableCount > 30 ||
      !Number.isInteger(config.restStableCount) || config.restStableCount < 1 || config.restStableCount > 30 ||
      !Number.isInteger(config.releaseCount) || config.releaseCount < 1 || config.releaseCount > 30 ||
      !Number.isFinite(config.maxGapMs) || config.maxGapMs <= 0) throw new Error('无效过滤参数：预测数须为 1–30 的整数，释放阈值必须低于确认阈值。')
}
export function mappingMatches(labels: readonly string[], mapping: ClassMapping): boolean {
  return labels.length === 4 && new Set(labels).size === 4 && new Set(Object.values(mapping)).size === 4 &&
    DIRECTIONS.every(direction => labels.includes(mapping[direction]))
}
export function validFrame(frame: PredictionFrame): boolean {
  return typeof frame.id === 'string' && frame.id.length > 0 && Number.isFinite(frame.receivedAt) &&
    Array.isArray(frame.labels) && frame.labels.length === 4 && frame.labels.every(label => typeof label === 'string') &&
    Array.isArray(frame.probabilities) && frame.probabilities.length === 4 &&
    frame.probabilities.every(p => Number.isFinite(p) && p >= 0 && p <= 1) &&
    Math.abs(frame.probabilities.reduce((a, b) => a + b, 0) - 1) < .02 &&
    (frame.roundId === undefined || (typeof frame.roundId === 'string' && frame.roundId.length > 0))
}

/** Session-long dedupe; no timer/cooldown can rearm a sustained classification. */
export class BciCommandFilter {
  config: FilterConfig
  mapping: ClassMapping
  private seen = new Set<string>()
  private closedRounds = new Set<string>()
  private round: string | undefined
  private candidate: Direction | null = null
  private count = 0
  private release = 0
  private locked = false
  private lastAt = -Infinity
  private eligibleAfter = -Infinity
  message = '等待独立指令'
  constructor(mapping = MI_MAPPING, config = DEFAULT_FILTER) {
    validateConfig(config)
    this.mapping = { ...mapping }
    this.config = { ...config }
  }
  get progress(): number { return this.count }
  private clearEvidence(): void { this.candidate = null; this.count = 0; this.release = 0 }
  /** Preserve dedupe across pauses, mode changes, restarts, and level changes. */
  interrupt(now: number): void {
    this.clearEvidence()
    this.locked = true
    this.eligibleAfter = now
    if (this.round) this.closedRounds.add(this.round)
    this.round = undefined
    this.message = '等待释放后重新确认，或新的独立试次'
  }
  /** An explicit Start/Continue is a new acquisition boundary, not a held prediction. */
  begin(now: number): void {
    this.interrupt(now)
    this.locked = false
    this.message = '已就绪 · 等待新的稳定指令'
  }
  configure(mapping: ClassMapping, config: FilterConfig, now: number): void {
    validateConfig(config)
    this.mapping = { ...mapping }; this.config = { ...config }
    this.interrupt(now)
  }
  consume(frame: PredictionFrame, now: number, available: boolean): Direction | null {
    if (!validFrame(frame)) { this.clearEvidence(); this.message = '预测格式无效'; return null }
    if (this.seen.has(frame.id)) return null
    this.seen.add(frame.id)
    if (!available) {
      if (frame.roundId) this.closedRounds.add(frame.roundId)
      this.interrupt(now)
      this.message = '输入已丢弃 · 当前不接受指令'
      return null
    }
    if (frame.receivedAt <= this.eligibleAfter || frame.receivedAt < this.lastAt ||
        now - frame.receivedAt > this.config.maxGapMs || frame.receivedAt > now + 50) {
      this.clearEvidence(); this.message = '已丢弃过期或乱序预测'; return null
    }
    if (!mappingMatches(frame.labels, this.mapping)) {
      this.clearEvidence(); this.message = '类别不匹配，请核对映射'; return null
    }
    if (frame.receivedAt - this.lastAt > this.config.maxGapMs) this.clearEvidence()
    this.lastAt = frame.receivedAt
    if (frame.roundId) {
      if (this.closedRounds.has(frame.roundId)) return null
      if (this.round !== frame.roundId) {
        if (this.round) this.closedRounds.add(this.round)
        this.round = frame.roundId
        this.clearEvidence()
        this.locked = false
      }
    } else if (this.round) {
      this.closedRounds.add(this.round); this.round = undefined; this.clearEvidence(); this.locked = true
    }
    const confidence = Math.max(...frame.probabilities)
    if (!this.locked && frame.probabilities.filter(p => p === confidence).length !== 1) {
      this.clearEvidence(); this.message = '最高类别并列，等待明确指令'; return null
    }
    const direction = DIRECTIONS.find(d => this.mapping[d] === frame.labels[frame.probabilities.indexOf(confidence)])!
    if (this.locked) {
      this.release = confidence <= this.config.releaseThreshold ? this.release + 1 : 0
      if (this.release >= this.config.releaseCount) {
        this.locked = false; this.clearEvidence(); this.message = '已释放 · 等待新的稳定指令'
      } else this.message = `等待释放 · ${this.release}/${this.config.releaseCount}`
      return null
    }
    if (confidence < this.config.threshold) {
      this.clearEvidence()
      this.message = `置信度不足 · 最高 ${(confidence * 100).toFixed(1)}% / 阈值 ${(this.config.threshold * 100).toFixed(0)}%`
      return null
    }
    this.count = this.candidate === direction ? this.count + 1 : 1
    this.candidate = direction
    const isRest = this.mapping[direction] === 'rest'
    const required = isRest ? this.config.restStableCount : this.config.stableCount
    this.message = `${isRest ? 'rest ' : ''}稳定确认 · ${this.count}/${required}`
    if (this.count < required) return null
    this.locked = true
    if (this.round) this.closedRounds.add(this.round)
    this.clearEvidence()
    this.message = '指令已确认 · 等待释放'
    return direction
  }
}
