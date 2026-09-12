import { describe, expect, it } from 'vitest'
import {
  decodeOmniDataBatch,
  parseOmniText,
  sequenceGaps,
} from './protocol'

function header(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'data',
    schema_version: 1,
    dtype: 'float32',
    stream: 'raw',
    shape: [2, 8],
    channels: Array.from({ length: 8 }, (_, i) => `CH${i + 1}`),
    sequence: [10, 11],
    valid: [true, false],
    modes: [0, 1],
    sample_rate: 250,
    unit: 'uV',
    session_id: 's1',
    ...partial,
  }
}

describe('OmniBCI V19 protocol', () => {
  it('accepts a compatible hello', () => {
    const parsed = parseOmniText(
      JSON.stringify({
        type: 'hello',
        schema_version: 1,
        stream: 'raw',
        sample_rate: 250,
        channels: Array.from({ length: 8 }, (_, i) => `CH${i + 1}`),
        unit: 'uV',
        session_id: 'abc',
      }),
      'raw',
    )
    expect(parsed.kind).toBe('hello')
    if (parsed.kind !== 'hello') return
    expect(parsed.hello.sample_rate).toBe(250)
    expect(parsed.hello.channels).toHaveLength(8)
    expect(parsed.hello.session_id).toBe('abc')
  })

  it('rejects a filtered hello when subscribed to raw', () => {
    const parsed = parseOmniText(
      JSON.stringify({
        type: 'hello',
        schema_version: 1,
        stream: 'filtered',
        sample_rate: 250,
        channels: ['CH1'],
        unit: 'uV',
      }),
      'raw',
    )
    expect(parsed.kind).toBe('error')
  })

  it('decodes a float32 sample-major batch', () => {
    const values = new Float32Array(16)
    for (let i = 0; i < values.length; i++) values[i] = i + 0.5
    const decoded = decodeOmniDataBatch(header(), values.buffer, 'raw')
    expect('error' in decoded).toBe(false)
    if ('error' in decoded) return
    expect(decoded.samples).toBe(2)
    expect(decoded.channels).toBe(8)
    expect(decoded.values[0]).toBeCloseTo(0.5)
    expect(decoded.values[15]).toBeCloseTo(15.5)
    expect([...decoded.sequence]).toEqual([10, 11])
    expect([...decoded.valid]).toEqual([1, 0])
    expect([...decoded.modes]).toEqual([0, 1])
  })

  it('rejects a payload whose length does not match shape', () => {
    const decoded = decodeOmniDataBatch(header(), new ArrayBuffer(12), 'raw')
    expect('error' in decoded).toBe(true)
    if ('error' in decoded) expect(decoded.error).toContain('payload')
  })

  it('counts unsigned sequence wrap gaps', () => {
    expect(sequenceGaps(Uint32Array.from([5, 7, 8]), 4)).toEqual({ gaps: 1, last: 8 })
    expect(sequenceGaps(Uint32Array.from([0]), 0xffffffff).gaps).toBe(0)
  })
})
