import { FS } from '../protocol/constants'
import { DEFAULT_REVE_BAND } from '../../lib/model-runtime/reveFilter'
import { designOmniGuiFilter, sosfiltZi, type Sos } from './design'

export type { Sos }

const DEFAULT_FILTER = designOmniGuiFilter(FS, DEFAULT_REVE_BAND.lowHz, DEFAULT_REVE_BAND.highHz, DEFAULT_REVE_BAND.useNotch)

interface Zi {
  band: Float64Array
  notch: Float64Array
  last: Float64Array
  have: boolean[]
  bandSections: number
  notchSections: number
  nChannels: number
}

function allocZi(nChannels: number, bandSections: number, notchSections: number): Zi {
  return {
    band: new Float64Array(nChannels * bandSections * 2),
    notch: new Float64Array(nChannels * notchSections * 2),
    last: new Float64Array(nChannels),
    have: Array.from({ length: nChannels }, () => false),
    bandSections,
    notchSections,
    nChannels,
  }
}

function primeBandZi(zi: Zi, ch: number, first: number, bandSos: Sos): void {
  const unit = sosfiltZi(bandSos)
  const base = ch * zi.bandSections * 2
  for (let i = 0; i < unit.length; i++) zi.band[base + i] = unit[i]! * first
}

function sosfiltOne(
  sos: Sos,
  zi: Float64Array,
  ziBase: number,
  x: number,
): number {
  let v = x
  for (let s = 0; s < sos.length; s++) {
    const sec = sos[s]!
    const b0 = sec[0]!, b1 = sec[1]!, b2 = sec[2]!
    const a1 = sec[4]!, a2 = sec[5]!
    const z0 = zi[ziBase + s * 2]!
    const z1 = zi[ziBase + s * 2 + 1]!
    const y = b0 * v + z0
    zi[ziBase + s * 2] = b1 * v - a1 * y + z1
    zi[ziBase + s * 2 + 1] = b2 * v - a2 * y
    v = y
  }
  return v
}

/**
 * Causal multi-channel SOS filter (bandpass + optional notch).
 * Channel count is dynamic (OmniBCI 8-ch or Neuracle 59-ch).
 */
export class LiveIirFilter {
  private zi: Zi
  private generation = 0
  private bandSos: Sos
  private notchSos: Sos
  private useNotch: boolean
  private nChannels: number
  private scratch: Float32Array
  private batchScratch: Float32Array
  private settlingSamples: number | null = null
  private settlingLeft = new Uint32Array(0)
  private previousSequence: number | null = null

  constructor(
    nChannels = 8,
    bandSos: Sos = DEFAULT_FILTER.sos,
    notchSos: Sos = [],
    useNotch = false,
  ) {
    this.nChannels = nChannels
    this.bandSos = bandSos
    this.notchSos = notchSos
    this.useNotch = useNotch
    this.zi = allocZi(nChannels, bandSos.length, notchSos.length)
    if (bandSos === DEFAULT_FILTER.sos) {
      this.settlingSamples = DEFAULT_FILTER.settlingSamples
      this.settlingLeft = new Uint32Array(nChannels).fill(this.settlingSamples)
    }
    this.scratch = new Float32Array(nChannels)
    this.batchScratch = new Float32Array(0)
  }

  setChannelCount(n: number): void {
    if (n === this.nChannels) return
    this.nChannels = n
    this.reset()
    this.scratch = new Float32Array(n)
    this.batchScratch = new Float32Array(0)
  }

  configure(bandSos: Sos, notchSos: Sos, useNotch: boolean, settlingSamples: number | null = null): void {
    this.bandSos = bandSos
    this.notchSos = notchSos
    this.useNotch = useNotch
    this.settlingSamples = settlingSamples
    this.reset()
  }

  reset(): void {
    this.zi = allocZi(this.nChannels, this.bandSos.length, this.notchSos.length)
    this.settlingLeft = new Uint32Array(this.settlingSamples === null ? 0 : this.nChannels)
    this.settlingLeft.fill(this.settlingSamples ?? 0)
    this.previousSequence = null
    this.generation += 1
  }

  getGeneration(): number {
    return this.generation
  }

  private noteFrame(sequence: number | undefined, valid: boolean): void {
    if (this.settlingSamples === null) return
    if (!valid || (sequence !== undefined && (this.previousSequence === null ||
        sequence !== ((this.previousSequence + 1) >>> 0)))) {
      this.zi.have.fill(false)
      this.settlingLeft.fill(this.settlingSamples)
    }
    this.previousSequence = valid ? sequence ?? null : null
  }

  private processValue(value: number, valid: boolean, ch: number): number {
    const zi = this.zi
    const finite = valid && Number.isFinite(value)
    if (this.settlingSamples !== null && !finite) {
      zi.have[ch] = false
      this.settlingLeft[ch] = this.settlingSamples
      this.previousSequence = null
      return Number.NaN
    }

    const x = finite ? value : zi.have[ch] ? zi.last[ch]! : 0
    if (finite) {
      if (!zi.have[ch]) primeBandZi(zi, ch, x, this.bandSos)
      zi.last[ch] = x
      zi.have[ch] = true
    }
    const band = sosfiltOne(this.bandSos, zi.band, ch * zi.bandSections * 2, x)
    const y = this.useNotch ? sosfiltOne(this.notchSos, zi.notch, ch * zi.notchSections * 2, band) : band
    if (!finite) return Number.NaN
    if (this.settlingSamples !== null && this.settlingLeft[ch]! > 0) {
      this.settlingLeft[ch] = this.settlingLeft[ch]! - 1
      if (this.settlingLeft[ch]! > 0) return Number.NaN
    }
    return y
  }

  processSample(uv: Float32Array, valid: boolean, sequence?: number): Float32Array {
    const n = Math.min(this.nChannels, uv.length)
    if (this.scratch.length !== this.nChannels) this.scratch = new Float32Array(this.nChannels)
    const out = this.scratch
    this.noteFrame(sequence, valid)
    for (let ch = 0; ch < n; ch++) out[ch] = this.processValue(uv[ch]!, valid, ch)
    return out
  }

  /** Filter an interleaved (sample-major) batch in place of per-sample calls. */
  processInterleaved(values: Float32Array, samples: number, channels: number, validFlags?: Uint8Array, sequence?: Uint32Array): Float32Array {
    const n = Math.max(1, channels)
    if (n !== this.nChannels) this.setChannelCount(n)
    const need = samples * n
    if (this.batchScratch.length < need) this.batchScratch = new Float32Array(need)
    const out = this.batchScratch
    for (let s = 0; s < samples; s++) {
      const off = s * n
      const valid = this.settlingSamples === null || (validFlags?.[s] ?? 1) === 1
      this.noteFrame(sequence?.[s], valid)
      for (let ch = 0; ch < n; ch++) out[off + ch] = this.processValue(values[off + ch]!, valid, ch)
    }
    return this.batchScratch.subarray(0, need)
  }
}
