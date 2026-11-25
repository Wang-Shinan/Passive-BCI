import { describe, expect, it } from 'vitest'
import { DEFAULT_REVE_BAND } from '../../lib/model-runtime/reveFilter'
import { designNotchCascade, designOmniGuiFilter, type Sos } from './design'
import { LiveIirFilter } from './iir'

function gainAt(sos: Sos, frequency: number, sampleRate: number): number {
  const angle = 2 * Math.PI * frequency / sampleRate
  const magnitude = (a: number, b: number, c: number) =>
    Math.hypot(a + b * Math.cos(angle) + c * Math.cos(2 * angle), b * Math.sin(angle) + c * Math.sin(2 * angle))
  return sos.reduce((gain, section) => gain * magnitude(section[0]!, section[1]!, section[2]!) /
    magnitude(section[3]!, section[4]!, section[5]!), 1)
}

describe('acquisition display filter', () => {
  it('retains a 99.5 Hz cutoff at a 200 Hz sample rate', () => {
    const { sos: band } = designOmniGuiFilter(200, DEFAULT_REVE_BAND.lowHz, DEFAULT_REVE_BAND.highHz, false)
    expect(gainAt(band, 0.5, 200)).toBeCloseTo(Math.SQRT1_2, 3)
    expect(gainAt(band, 80, 200)).toBeGreaterThan(0.99)
    expect(gainAt(band, 99.5, 200)).toBeCloseTo(Math.SQRT1_2, 3)
  })

  it.each([50, 100])('rejects %s Hz in the default live filter', frequency => {
    const filter = new LiveIirFilter(1)
    const sample = new Float32Array(1)
    let power = 0
    for (let i = 0; i < 1250; i++) {
      sample[0] = Math.sin(2 * Math.PI * frequency * i / 250)
      const value = filter.processSample(sample, true)[0]!
      if (i >= 1000) power += value ** 2
    }
    expect(Math.sqrt(power / 250)).toBeLessThan(0.002)
  })

  it('adds only notch frequencies below Nyquist', () => {
    expect(designNotchCascade(100)).toHaveLength(0)
    expect(designNotchCascade(200)).toHaveLength(1)
    expect(designNotchCascade(250)).toHaveLength(2)
  })

  it.each([
    { highpass: 0.5, lowpass: 99.5, notch: false, first: 900, sample: 1000, expected: -262.7369 },
    { highpass: 5, lowpass: 50, notch: true, first: 381, sample: 381, expected: -17.648659 },
  ])('matches the upstream cascade at $highpass–$lowpass Hz across streamed batches', ({
    highpass, lowpass, notch, first, sample, expected,
  }) => {
    const rate = 250
    const design = designOmniGuiFilter(rate, highpass, lowpass, notch)
    const filter = new LiveIirFilter(1)
    filter.configure(design.sos, [], false, design.settlingSamples)
    const indices = Uint32Array.from({ length: 2400 }, (_, i) => i)
    const data = Float32Array.from(indices, i => {
      const t = i / rate
      return 51000 + 20 * Math.sin(2 * Math.PI * 11 * t) + 800 * Math.sin(2 * Math.PI * 50 * t)
    })
    const valid = new Uint8Array(data.length).fill(1)
    valid[1150] = 0
    const output = new Float32Array(data.length)
    for (let i = 0; i < data.length; i += 137) {
      const slice = data.subarray(i, i + 137)
      output.set(filter.processInterleaved(slice, slice.length, 1, valid.subarray(i, i + 137), indices.subarray(i, i + 137)), i)
    }
    // Reference output obtained from the upstream Rust SignalFilter at 8dba492.
    expect(output[first - 1]).toBeNaN()
    expect(output[sample]).toBeCloseTo(expected, 3)
    expect(output[1150]).toBeNaN()
    expect(output[1150 + first]).toBeNaN()
    expect(Number.isFinite(output[1151 + first])).toBe(true)
  })

  it('restarts the settling interval at a sequence gap', () => {
    const design = designOmniGuiFilter(250, 5, 50, true)
    const filter = new LiveIirFilter(1)
    filter.configure(design.sos, [], false, design.settlingSamples)
    const value = Float32Array.of(51000)
    for (let i = 0; i < design.settlingSamples; i++) filter.processSample(value, true, i)
    expect(filter.processSample(value, true, design.settlingSamples)[0]).toBeCloseTo(0, 5)
    expect(filter.processSample(value, true, design.settlingSamples + 2)[0]).toBeNaN()
  })
})
