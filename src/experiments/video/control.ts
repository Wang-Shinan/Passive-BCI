import type { ModelPrediction } from '../../lib/model-runtime/contracts'

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
