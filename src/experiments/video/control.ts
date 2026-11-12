import type { ModelPrediction } from '../../lib/model-runtime/contracts'

export type SwitchDecisionMode = 'streak' | 'vote' | 'direct'

/**
 * Control channel → playback rate. The control value is normalized against the
 * driver's configured output range (0–100 by default), then linearly mapped
 * into [minRate, maxRate] and clamped to the supported 0.25–3.00× band.
 */
export function playbackRateForControl(control: number, minRate: number, maxRate: number, outMin = 0, outMax = 100): number {
  const span = outMax - outMin
  const t = Math.abs(span) < 1e-9 || !Number.isFinite(control)
    ? 0.5
    : Math.max(0, Math.min(1, (control - outMin) / span))
  return Math.max(0.25, Math.min(3, minRate + t * (maxRate - minRate)))
}

/**
 * Threshold mode: a two-bucket rate — below threshold 1×, at/above 2×.
 * No hysteresis; non-finite inputs fall back to 1×.
 */
export function playbackRateForThreshold(control: number, threshold: number): number {
  return Number.isFinite(control) && Number.isFinite(threshold) && control >= threshold ? 2 : 1
}

export type SwitchSettings = {
  confidence: number
  confirmations: number
  cooldownMs: number
  mode?: SwitchDecisionMode
  /** vote: majority window size and required fraction of that window. */
  voteWindow?: number
  voteFraction?: number
}

/** One decision per stable class; duplicate, delayed and out-of-order predictions never count twice. */
export class VideoSwitchGate {
  private lastReceived = -Infinity
  private lastId = ''
  private candidate = ''
  private count = 0
  private latched = ''
  private lastSwitch = -Infinity
  private recent: string[] = []

  reset() {
    this.lastReceived = -Infinity
    this.lastId = this.candidate = this.latched = ''
    this.count = 0
    this.lastSwitch = -Infinity
    this.recent = []
  }

  suspend() {
    this.candidate = ''
    this.count = 0
    this.recent = []
  }

  accept(p: ModelPrediction, now: number, settings: SwitchSettings): string | null {
    if (p.observation_id === this.lastId || p.received_at_ms <= this.lastReceived) return null
    const gap = p.received_at_ms - this.lastReceived
    this.lastId = p.observation_id
    this.lastReceived = p.received_at_ms
    if (now - p.received_at_ms > 1500 || now < p.received_at_ms || !Number.isFinite(p.confidence) || p.confidence < settings.confidence) {
      this.candidate = ''; this.count = 0; this.recent = []
      return null
    }
    if (gap > 1500) { this.candidate = ''; this.count = 0; this.recent = [] }
    if (!p.class_name || !p.class_names.includes(p.class_name)) return null
    if (this.candidate === p.class_name) this.count++
    else { this.candidate = p.class_name; this.count = 1 }
    this.recent.push(p.class_name)
    const k = Math.max(1, Math.round(settings.voteWindow ?? 5))
    if (this.recent.length > k) this.recent.shift()

    if (this.latched === p.class_name || now - this.lastSwitch < settings.cooldownMs) return null
    const mode = settings.mode ?? 'streak'
    if (mode === 'direct') {
      this.latched = p.class_name
      this.lastSwitch = now
      return p.class_name
    }
    if (mode === 'vote') {
      if (this.recent.length < k) return null
      const needed = Math.max(1, Math.ceil((settings.voteFraction ?? 0.6) * k))
      const votes = this.recent.filter((name) => name === p.class_name).length
      if (votes < needed) return null
      this.latched = p.class_name
      this.lastSwitch = now
      return p.class_name
    }
    if (this.count < settings.confirmations) return null
    this.latched = p.class_name
    this.lastSwitch = now
    return p.class_name
  }
}
