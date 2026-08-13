/** Shared live-EEG ring. Acquisition writes; experiments read across SPA routes. */

export type LiveEegDevice = 'omni' | 'neuracle' | 'bcigo' | 'demo' | null
export type LiveEegLink = 'idle' | 'connecting' | 'open' | 'streaming' | 'demo' | 'error'

export const LIVE_FRESH_MS = 1500
const HUB_SECONDS = 6

export type LiveEegMeta = {
  device: LiveEegDevice
  link: LiveEegLink
  sampleRate: number
  channelNames: string[]
  lastAt: number
  detail: string
}

export type LiveEegRing = {
  buffers: Float32Array[]
  writeHead: number
  filled: number
  capacity: number
  sampleRate: number
}

class LiveEegHub {
  buffers: Float32Array[] = []
  capacity = 0
  writeHead = 0
  filled = 0
  sampleRate = 250
  channelNames: string[] = []
  device: LiveEegDevice = null
  link: LiveEegLink = 'idle'
  lastAt = 0
  detail = ''
  private listeners = new Set<() => void>()

  configure(opts: {
    sampleRate?: number
    channelNames?: string[]
    device?: LiveEegDevice
    detail?: string
  }): void {
    if (opts.sampleRate != null && opts.sampleRate > 0) this.sampleRate = opts.sampleRate
    if (opts.channelNames) {
      this.channelNames = [...opts.channelNames]
      this.ensureRing(opts.channelNames.length)
    }
    if (opts.device !== undefined) this.device = opts.device
    if (opts.detail !== undefined) this.detail = opts.detail
    this.emit()
  }

  ensureRing(nChannels: number): void {
    const n = Math.max(1, nChannels)
    const cap = Math.max(16, Math.floor(this.sampleRate * HUB_SECONDS))
    if (this.buffers.length === n && this.capacity === cap) return
    this.buffers = Array.from({ length: n }, () => new Float32Array(cap))
    this.capacity = cap
    this.writeHead = 0
    this.filled = 0
  }

  pushFrame(sample: ArrayLike<number>): void {
    const n = sample.length
    if (n <= 0) return
    if (this.buffers.length !== n) {
      if (this.channelNames.length !== n) {
        this.channelNames = Array.from({ length: n }, (_, i) => this.channelNames[i] ?? `Ch${i + 1}`)
      }
      this.ensureRing(n)
    }
    const i = this.writeHead
    for (let c = 0; c < this.buffers.length; c++) {
      this.buffers[c]![i] = sample[c] ?? 0
    }
    this.writeHead = (i + 1) % this.capacity
    this.filled = Math.min(this.capacity, this.filled + 1)
    this.lastAt = performance.now()
  }

  pushInterleaved(values: Float32Array, samples: number, channels: number): void {
    if (samples <= 0 || channels <= 0) return
    for (let s = 0; s < samples; s++) {
      this.pushFrame(values.subarray(s * channels, s * channels + channels))
    }
  }

  markConnecting(detail?: string): void {
    this.link = 'connecting'
    if (detail !== undefined) this.detail = detail
    this.emit()
  }

  markOpen(detail?: string): void {
    this.link = 'open'
    if (detail !== undefined) this.detail = detail
    this.emit()
  }

  markStreaming(detail?: string): void {
    this.link = this.device === 'demo' ? 'demo' : 'streaming'
    if (detail !== undefined) this.detail = detail
    this.emit()
  }

  markError(detail?: string): void {
    this.link = 'error'
    if (detail !== undefined) this.detail = detail
    this.emit()
  }

  markIdle(detail?: string): void {
    this.link = 'idle'
    this.device = null
    this.lastAt = 0
    this.writeHead = 0
    this.filled = 0
    for (const buf of this.buffers) buf.fill(0)
    this.detail = detail ?? ''
    this.emit()
  }

  isFresh(maxAgeMs = LIVE_FRESH_MS): boolean {
    if (this.link !== 'streaming' && this.link !== 'demo') return false
    if (!this.lastAt || this.filled < 16) return false
    return performance.now() - this.lastAt <= maxAgeMs
  }

  get meta(): LiveEegMeta {
    return {
      device: this.device,
      link: this.link,
      sampleRate: this.sampleRate,
      channelNames: this.channelNames,
      lastAt: this.lastAt,
      detail: this.detail,
    }
  }

  get ring(): LiveEegRing {
    return {
      buffers: this.buffers,
      writeHead: this.writeHead,
      filled: this.filled,
      capacity: this.capacity,
      sampleRate: this.sampleRate,
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

export const liveEegHub = new LiveEegHub()
