/** Map EEG batches onto the browser clock using Neuracle device timestamps. */
import { lslClock, type LslTiming } from './lslClock'
import type { SystemClockStamp } from './systemClock'

const UINT32_MS = 2 ** 32

export type SampleClockSource = 'device' | 'arrival' | 'lsl'

export type SampleClockNote = {
  receivedClock?: SystemClockStamp
  native?: { sequence: number; sourceTimestampMs: number | null }
  lsl?: LslTiming
  samples: number
  sampleRate: number
  arrivalNowMs: number
  deviceEndMs?: number
}

export type SampleClockSnapshot = {
  receivedClock?: SystemClockStamp
  native?: { sequence: number; sourceTimestampMs: number | null }
  lsl?: { streamId: string; lastSourceTimestampSec: number; correctionSec: number | null
    eventLocalSec: number | null; browserOffsetMs: number | null; syncRttMs: number | null; syncAgeMs: number | null }
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
  private lsl: LslTiming | undefined
  private native: SampleClockNote['native']
  private receivedClock: SystemClockStamp | undefined
  private readonly batches: SampleClockBatchDump[] = []
  private static readonly MAX_BATCHES = 1024

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
    this.lsl = undefined
    this.native = undefined
    this.receivedClock = undefined
    this.batches.length = 0
  }

  get hasDeviceTime(): boolean {
    return this.minOffsetMs !== null
  }

  pipelineDelayMs(): number {
    if (!this.sampleIndex) return 0
    return Math.max(0, this.lastArrivalMs - this.lastAcquiredMs)
  }

  snapshot(eventNowMs = performance.now()): SampleClockSnapshot | null {
    if (!this.sampleIndex) return null
    const mapping = this.lsl ? lslClock.mapping(eventNowMs) : null
    return {
      ...(this.native ? { native: this.native } : {}),
      ...(this.receivedClock ? { receivedClock: this.receivedClock } : {}),
      ...(this.lsl ? { lsl: { streamId: this.lsl.streamId, lastSourceTimestampSec: this.lsl.timestampsSec.at(-1)!,
        correctionSec: this.lsl.correctionSec, eventLocalSec: mapping ? (eventNowMs + mapping.offsetMs) / 1000 : null,
        browserOffsetMs: mapping?.offsetMs ?? null, syncRttMs: mapping?.rttMs ?? null, syncAgeMs: mapping?.ageMs ?? null } } : {}),
      sampleIndex: this.sampleIndex,
      sampleRate: this.sampleRate,
      arrivalNowMs: this.lastArrivalMs,
      deviceEndMs: this.lastDeviceEndMs,
      acquiredNowMs: this.lastAcquiredMs,
      source: this.lsl && !mapping ? 'arrival' : this.source,
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
    this.lsl = note.lsl
    this.native = note.native
    this.receivedClock = note.receivedClock

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
    if (note.lsl) {
      const mapping = lslClock.mapping(note.arrivalNowMs)
      this.source = 'arrival'
      if (mapping && note.lsl.correctionSec !== null) {
        acquiredMs = (note.lsl.timestampsSec.at(-1)! + note.lsl.correctionSec) * 1000 - mapping.offsetMs
        this.source = 'lsl'
      }
    }

    this.lastAcquiredMs = acquiredMs
    this.batches.push({
      i: this.sampleIndex,
      n,
      arrivalMs: note.arrivalNowMs,
      deviceEndMs: this.lastDeviceEndMs,
      acquiredMs,
    })
    if (this.batches.length > SampleClock.MAX_BATCHES) {
      this.batches.splice(0, this.batches.length - SampleClock.MAX_BATCHES)
    }
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
