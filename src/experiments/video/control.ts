import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { applyRangeMap, displayValueForDriver } from '../../lib/features/controlMapping'
import type { LiveFeatureSnapshot } from '../../lib/features/bandFeatures'

export type AttentionSpeedSettings = { minRate: number; maxRate: number; lowScore: number; highScore: number }
export const DEFAULT_ATTENTION_SPEED: AttentionSpeedSettings = { minRate: .75, maxRate: 1.5, lowScore: 30, highScore: 70 }

export function validAttentionSpeed(settings: AttentionSpeedSettings): boolean {
  const { minRate, maxRate, lowScore, highScore } = settings
  return Object.values(settings).every(Number.isFinite) && minRate >= .5 && maxRate <= 2 && minRate <= maxRate
    && lowScore >= 0 && highScore <= 100 && lowScore < highScore
}

/** Slew-limited speed; a missing/stale real EEG window immediately restores 1x. */
export class AttentionSpeedControl {
  private rate = 1
  private lastChange = -Infinity
  private lastSample = -Infinity

  reset() { this.rate = 1; this.lastChange = this.lastSample = -Infinity }

  accept(sample: { raw: number; at: number; sourceAt: number } | null, now: number, settings: AttentionSpeedSettings, targetRate?: number) {
    if (!sample || ![sample.raw, sample.at, sample.sourceAt, now].every(Number.isFinite) || sample.raw < 0
      || now < sample.at || now - sample.at > 1500 || now < sample.sourceAt || now - sample.sourceAt > 1500
      || !validAttentionSpeed(settings) || (targetRate !== undefined && (!Number.isFinite(targetRate) || targetRate < .5 || targetRate > 2))) {
      this.reset()
      return { rate: 1, score: null }
    }
    const score = displayValueForDriver('focus_score', sample.raw)
    const target = targetRate ?? applyRangeMap(score, { inMin: settings.lowScore, inMax: settings.highScore, outMin: settings.minRate, outMax: settings.maxRate })
    if (sample.at > this.lastSample && now - this.lastChange >= 1000) {
      this.rate += Math.max(-.1, Math.min(.1, target - this.rate))
      this.lastChange = now
      this.lastSample = sample.at
    }
    return { rate: this.rate, score }
  }
}

export function calibrateAttentionSpeed(history: LiveFeatureSnapshot[], now: number): [number, number] | null {
  const samples = history.filter(p => p.t <= now && now - p.t <= 10000 && Number.isFinite(p.values.focus_score) && p.values.focus_score >= 0)
  if (samples.length < 25 || now - samples.at(-1)!.t > 1500 || samples.at(-1)!.t - samples[0]!.t < 5000) return null
  const scores = samples.map(p => displayValueForDriver('focus_score', p.values.focus_score)).sort((a, b) => a - b)
  const low = Math.floor(scores[Math.floor((scores.length - 1) * .1)])
  const high = Math.ceil(scores[Math.ceil((scores.length - 1) * .9)])
  // ponytail: a short personal percentile range; repeat calibration after electrode or session changes.
  return high - low >= 5 ? [low, high] : null
}

export type SwitchSettings = { confidence: number; confirmations: number; cooldownMs: number }

/** One decision per stable class; duplicate, delayed and out-of-order predictions never count twice. */
export class VideoSwitchGate {
  private lastReceived = -Infinity
  private lastId = ''
  private candidate = ''
  private count = 0
  private latched = ''
  private lastSwitch = -Infinity

  reset() {
    this.lastReceived = -Infinity
    this.lastId = this.candidate = this.latched = ''
    this.count = 0
    this.lastSwitch = -Infinity
  }

  suspend() {
    this.candidate = ''
    this.count = 0
  }

  accept(p: ModelPrediction, now: number, settings: SwitchSettings): string | null {
    if (p.observation_id === this.lastId || p.received_at_ms <= this.lastReceived) return null
    const gap = p.received_at_ms - this.lastReceived
    this.lastId = p.observation_id
    this.lastReceived = p.received_at_ms
    if (now - p.received_at_ms > 1500 || now < p.received_at_ms || !Number.isFinite(p.confidence) || p.confidence < settings.confidence) {
      this.candidate = ''; this.count = 0
      return null
    }
    if (gap > 1500) { this.candidate = ''; this.count = 0 }
    if (!p.class_name || !p.class_names.includes(p.class_name)) return null
    if (this.candidate === p.class_name) this.count++
    else { this.candidate = p.class_name; this.count = 1 }
    if (this.count < settings.confirmations || this.latched === p.class_name || now - this.lastSwitch < settings.cooldownMs) return null
    this.latched = p.class_name
    this.lastSwitch = now
    return p.class_name
  }
}
