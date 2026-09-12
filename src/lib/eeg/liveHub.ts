/** Shared live-EEG ring. Acquisition writes; experiments read across SPA routes. */

export type LiveEegDevice = 'omni' | 'neuracle' | 'bcigo' | 'demo' | null
export type LiveEegLink = 'idle' | 'connecting' | 'open' | 'streaming' | 'demo' | 'error'

export const LIVE_FRESH_MS = 8000
/** Stay live through a stalled flush / GPU hitch; only show 已过期 after a real gap. */
export const LIVE_STALE_MS = 15000
const HUB_SECONDS = 6
const HIDDEN_CH_KEY = 'passive-bci.hidden-channel-names'
/** Off by default (EOG / unused on BCIGo 32-ch). */
export const DEFAULT_HIDDEN_CHANNELS = ['IO']

export function normalizeChannelName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase()
}

export function loadHiddenChannelNames(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_CH_KEY) ?? 'null') as unknown
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed.map(normalizeChannelName)
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_HIDDEN_CHANNELS.map(normalizeChannelName)
}

export function saveHiddenChannelNames(names: string[]): void {
  localStorage.setItem(
    HIDDEN_CH_KEY,
    JSON.stringify([...new Set(names.map(normalizeChannelName))]),
  )
}

export function visibleMaskForNames(names: string[]): boolean[] {
  const hidden = new Set(loadHiddenChannelNames())
  return names.map((n) => !hidden.has(normalizeChannelName(n)))
}

/** Merge current montage into the persisted hidden-name set (absent names stay as-is). */
export function persistHiddenFromMask(names: string[], visible: boolean[]): void {
  const hidden = new Set(loadHiddenChannelNames())
  names.forEach((name, i) => {
    const key = normalizeChannelName(name)
    if (visible[i] === false) hidden.add(key)
    else hidden.delete(key)
  })
  saveHiddenChannelNames([...hidden])
}

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
  channelMask: boolean[] = []
  private liveLatch = false
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
      if (this.channelMask.length !== opts.channelNames.length) {
        this.channelMask = visibleMaskForNames(opts.channelNames)
      }
    } else if (opts.sampleRate != null && this.buffers.length) {
      this.ensureRing(this.buffers.length)
    }
    if (opts.device !== undefined) this.device = opts.device
    if (opts.detail !== undefined) this.detail = opts.detail
    this.emit()
  }

  setChannelMask(mask: boolean[]): void {
    this.channelMask = [...mask]
  }

  /** Mask aligned to current ring length; omitted channels count as included. */
  featureChannelMask(): boolean[] | undefined {
    const n = this.buffers.length
    if (!n || !this.channelMask.length) return undefined
    if (this.channelMask.length === n) return this.channelMask
    return Array.from({ length: n }, (_, i) => this.channelMask[i] !== false)
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
    this.liveLatch = true
  }

  pushInterleaved(values: Float32Array, samples: number, channels: number): void {
    if (samples <= 0 || channels <= 0) return
    if (this.buffers.length !== channels) {
      if (this.channelNames.length !== channels) {
        this.channelNames = Array.from(
          { length: channels },
          (_, i) => this.channelNames[i] ?? `Ch${i + 1}`,
        )
      }
      this.ensureRing(channels)
    }
    const cap = this.capacity
    let head = this.writeHead
    for (let s = 0; s < samples; s++) {
      const off = s * channels
      for (let c = 0; c < channels; c++) {
        this.buffers[c]![head] = values[off + c]!
      }
      head = (head + 1) % cap
    }
    this.writeHead = head
    this.filled = Math.min(cap, this.filled + samples)
    this.lastAt = performance.now()
    this.liveLatch = true
  }

  /** Packet arrived even if the ingest queue has not drained into the ring yet. */
  noteArrival(): void {
    this.lastAt = performance.now()
    if (this.link === 'streaming' || this.link === 'demo') this.liveLatch = true
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
    this.liveLatch = false
    this.writeHead = 0
    this.filled = 0
    for (const buf of this.buffers) buf.fill(0)
    this.detail = detail ?? ''
    this.emit()
  }

  isFresh(maxAgeMs = LIVE_FRESH_MS): boolean {
    if (this.link !== 'streaming' && this.link !== 'demo') {
      this.liveLatch = false
      return false
    }
    if (!this.lastAt || this.filled < 16) return false
    const age = performance.now() - this.lastAt
    if (age <= maxAgeMs) {
      this.liveLatch = true
      return true
    }
    if (this.liveLatch && age <= LIVE_STALE_MS) return true
    this.liveLatch = false
    return false
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
