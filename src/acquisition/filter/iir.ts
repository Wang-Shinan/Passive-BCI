export type Sos = number[][] // each section: [b0,b1,b2,a0,a1,a2]

/** Default OmniBCI display band: Butterworth order-2, 5–50 Hz @ 250 SPS. */
export const DEFAULT_BAND_SOS: Sos = [
  [
    0.1750876436721008, 0.3501752873442016, 0.1750876436721008, 1.0,
    -0.47338545635197227, 0.26070108314598184,
  ],
  [1.0, -2.0, 1.0, 1.0, -1.8256698996865246, 0.8425510982273042],
]

/** Cascaded 50 Hz + 100 Hz iirnotch Q=30 @ 250 SPS. */
export const DEFAULT_NOTCH_SOS: Sos = [
  [
    0.9794827609814495, -0.605353637681125, 0.9794827609814492, 1.0,
    -0.6053536376811253, 0.958965521962899,
  ],
  [
    0.95977356895352, 1.552946256070586, 0.9597735689535198, 1.0,
    1.552946256070586, 0.9195471379070399,
  ],
]

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

  constructor(
    nChannels = 8,
    bandSos: Sos = DEFAULT_BAND_SOS,
    notchSos: Sos = DEFAULT_NOTCH_SOS,
    useNotch = true,
  ) {
    this.nChannels = nChannels
    this.bandSos = bandSos
    this.notchSos = notchSos
    this.useNotch = useNotch
    this.zi = allocZi(nChannels, bandSos.length, notchSos.length)
  }

  setChannelCount(n: number): void {
    if (n === this.nChannels) return
    this.nChannels = n
    this.zi = allocZi(n, this.bandSos.length, this.notchSos.length)
    this.generation += 1
  }

  configure(bandSos: Sos, notchSos: Sos, useNotch: boolean): void {
    this.bandSos = bandSos
    this.notchSos = notchSos
    this.useNotch = useNotch
    this.zi = allocZi(this.nChannels, bandSos.length, notchSos.length)
    this.generation += 1
  }

  reset(): void {
    this.zi = allocZi(this.nChannels, this.bandSos.length, this.notchSos.length)
    this.generation += 1
  }

  getGeneration(): number {
    return this.generation
  }

  processSample(uv: Float32Array, valid: boolean): Float32Array {
    const n = Math.min(this.nChannels, uv.length)
    const out = new Float32Array(this.nChannels)
    for (let ch = 0; ch < n; ch++) {
      let x = uv[ch]!
      if (!valid || !Number.isFinite(x)) {
        x = this.zi.have[ch] ? this.zi.last[ch]! : 0
      } else {
        this.zi.last[ch] = x
        this.zi.have[ch] = true
      }

      let y = sosfiltOne(
        this.bandSos,
        this.zi.band,
        ch * this.zi.bandSections * 2,
        x,
      )
      if (this.useNotch) {
        y = sosfiltOne(
          this.notchSos,
          this.zi.notch,
          ch * this.zi.notchSections * 2,
          y,
        )
      }
      out[ch] = valid && Number.isFinite(uv[ch]!) ? y : Number.NaN
    }
    return out
  }
}
