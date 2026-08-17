/** Map EEG batches onto the browser clock using Neuracle device timestamps. */

const UINT32_MS = 2 ** 32

export type SampleClockSource = 'device' | 'arrival'

export type SampleClockNote = {
  samples: number
  sampleRate: number
  arrivalNowMs: number
  deviceEndMs?: number
}

export type SampleClockSnapshot = {
  sampleIndex: number
  sampleRate: number
  arrivalNowMs: number
  deviceEndMs: number | null
  acquiredNowMs: number
  source: SampleClockSource
  pipelineDelayMs: number
}

export type SampleClockBatchDump = {
  i: number
  n: number
  arrivalMs: number
  deviceEndMs: number | null
  acquiredMs: number
}

export type SampleClockDump = {
  version: 1
  sampleRate: number
  source: SampleClockSource
  sampleIndex: number
  minOffsetMs: number | null
  batches: SampleClockBatchDump[]
}

export class SampleClock {
  private sampleRate = 250
  private sampleIndex = 0
  private lastArrivalMs = 0
  private lastAcquiredMs = 0
  private lastDeviceEndMs: number | null = null
  private lastRawDeviceEndMs: number | null = null
  private wraps = 0
  private minOffsetMs: number | null = null
  private source: SampleClockSource = 'arrival'
  private readonly batches: SampleClockBatchDump[] = []

  reset(): void {
    this.sampleRate = 250
    this.sampleIndex = 0
    this.lastArrivalMs = 0
    this.lastAcquiredMs = 0
    this.lastDeviceEndMs = null
    this.lastRawDeviceEndMs = null
    this.wraps = 0
    this.minOffsetMs = null
    this.source = 'arrival'
    this.batches.length = 0
  }

  get hasDeviceTime(): boolean {
    return this.minOffsetMs !== null
  }

  pipelineDelayMs(): number {
    if (!this.sampleIndex) return 0
    return Math.max(0, this.lastArrivalMs - this.lastAcquiredMs)
  }

  snapshot(): SampleClockSnapshot | null {
    if (!this.sampleIndex) return null
    return {
      sampleIndex: this.sampleIndex,
      sampleRate: this.sampleRate,
      arrivalNowMs: this.lastArrivalMs,
      deviceEndMs: this.lastDeviceEndMs,
      acquiredNowMs: this.lastAcquiredMs,
      source: this.source,
      pipelineDelayMs: Math.max(0, this.lastArrivalMs - this.lastAcquiredMs),
    }
  }

  /**
   * Sample index whose estimated acquisition time is `acquiredMs`
   * (performance.now domain). May be slightly ahead of arrived data.
   */
  sampleIndexAt(acquiredMs: number): number | null {
    if (!this.sampleIndex) return null
    const last = this.batches[this.batches.length - 1]
    if (!last) return null
    const dt = acquiredMs - last.acquiredMs
    return Math.max(0, last.i + (dt * this.sampleRate) / 1000)
  }

  dump(): SampleClockDump {
    return {
      version: 1,
      sampleRate: this.sampleRate,
      source: this.source,
      sampleIndex: this.sampleIndex,
      minOffsetMs: this.minOffsetMs,
      batches: this.batches.map((b) => ({ ...b })),
    }
  }

  noteBatch(note: SampleClockNote): SampleClockSnapshot | null {
    if (note.samples <= 0) return null
    if (note.sampleRate > 0 && note.sampleRate !== this.sampleRate) {
      this.sampleRate = note.sampleRate
    }
    const n = note.samples
    this.sampleIndex += n
    this.lastArrivalMs = note.arrivalNowMs

    const rawDevice = finiteMs(note.deviceEndMs)
    let acquiredMs = note.arrivalNowMs
    if (rawDevice != null) {
      const deviceEndMs = this.unwrapDeviceMs(rawDevice)
      const offset = note.arrivalNowMs - deviceEndMs
      if (this.minOffsetMs === null || offset < this.minOffsetMs) {
        this.minOffsetMs = offset
      }
      acquiredMs = deviceEndMs + this.minOffsetMs
      this.lastDeviceEndMs = deviceEndMs
      this.source = 'device'
    } else {
      this.lastDeviceEndMs = null
      if (this.minOffsetMs === null) this.source = 'arrival'
    }

    this.lastAcquiredMs = acquiredMs
    this.batches.push({
      i: this.sampleIndex,
      n,
      arrivalMs: note.arrivalNowMs,
      deviceEndMs: this.lastDeviceEndMs,
      acquiredMs,
    })
    return this.snapshot()
  }

  private unwrapDeviceMs(raw: number): number {
    const modulus = UINT32_MS
    const normalized = ((raw % modulus) + modulus) % modulus
    if (
      this.lastRawDeviceEndMs !== null &&
      normalized < this.lastRawDeviceEndMs - modulus / 2
    ) {
      this.wraps += 1
    }
    this.lastRawDeviceEndMs = normalized
    return normalized + this.wraps * modulus
  }
}

function finiteMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const sampleClock = new SampleClock()
