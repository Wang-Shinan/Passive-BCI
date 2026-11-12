import { describe, expect, it } from 'vitest'
import { decodeGuiDataPage } from './guiProtocol'
import { OMNI_STREAM_RAW } from './protocol'

const NAMES = ['CH1', 'CH2']

function frame(seq: number, vals: unknown[], extra?: Record<string, unknown>) {
  return { sequence: seq, values_uv: vals, valid: true, mode: 0, source_timestamp_us: 0, ...extra }
}

function page(partial?: Record<string, unknown>) {
  return {
    generation: 7, oldest_cursor: 98, end_cursor: 102, next_cursor: 102,
    sample_rate_hz: 250, channel_names: [...NAMES],
    frames: [], source: 'original_device_frames', ...partial,
  }
}

describe('decodeGuiDataPage', () => {
  it('decodes sample-major rows with per-row flags and optional timestamps', () => {
    const out = decodeGuiDataPage(page({
      frames: [
        frame(0xffffffff, [1, 2], { valid: true, source_timestamp_us: 0 }),
        frame(0, [3, 4], { valid: false, mode: 7, source_timestamp_us: null }),
      ],
    }))
    expect(out.generation).toBe(7)
    expect(out.endCursor).toBe(102)
    expect(out.nextCursor).toBe(102)
    const b = out.batch
    expect(b.samples).toBe(2)
    expect(b.channels).toBe(2)
    expect(b.sampleRate).toBe(250)
    expect(b.channelNames).toEqual(NAMES)
    expect(b.unit).toBe('uV')
    expect(b.stream).toBe(OMNI_STREAM_RAW)
    // sample-major interleave
    expect(Array.from(b.values)).toEqual([1, 2, 3, 4])
    // uint32 wrap sequences preserved
    expect(Array.from(b.sequence)).toEqual([0xffffffff, 0])
    // invalid row retained, not filtered
    expect(Array.from(b.valid)).toEqual([1, 0])
    expect(Array.from(b.modes)).toEqual([0, 7])
    // 0 is a real timestamp; null → invalid mask 0
    expect(Array.from(b.sourceTimestampUs)).toEqual([0, 0])
    expect(Array.from(b.sourceTimestampValid)).toEqual([1, 0])
    expect(b.generation).toBe(7)
  })

  it('rejects a page whose source is not original_device_frames', () => {
    expect(() => decodeGuiDataPage(page({ source: 'lsl_frames' }))).toThrow(/source/)
  })

  it('rejects cursor bounds inconsistent with the returned rows', () => {
    expect(() => decodeGuiDataPage(page({
      oldest_cursor: 99, end_cursor: 102, next_cursor: 90,
      frames: [frame(1, [1, 2])],
    }))).toThrow(/cursor|bounds/)
    expect(() => decodeGuiDataPage(page({
      oldest_cursor: 105, end_cursor: 102, frames: [],
    }))).toThrow(/cursor|bounds/)
  })

  it('rejects non-safe-integer cursors and sequences', () => {
    expect(() => decodeGuiDataPage(page({ generation: 7.5 }))).toThrow(/generation/)
    expect(() => decodeGuiDataPage(page({ next_cursor: Number.MAX_SAFE_INTEGER + 1 }))).toThrow()
    expect(() => decodeGuiDataPage(page({
      frames: [frame(0x100000000, [1, 2])],
    }))).toThrow(/sequence/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1.5, [1, 2])],
    }))).toThrow(/sequence/)
  })

  it('rejects channel/value shape mismatches and non-finite floats', () => {
    expect(() => decodeGuiDataPage(page({ channel_names: [] }))).toThrow(/channel_names/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, 2, 3])],
    }))).toThrow(/values_uv/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, NaN])],
    }))).toThrow(/values_uv|finite/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, Infinity])],
    }))).toThrow(/values_uv|finite/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, 'x'])],
    }))).toThrow(/values_uv/)
  })

  it('rejects non-boolean valid and non-integer source timestamps', () => {
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, 2], { valid: 1 })],
    }))).toThrow(/valid/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, 2], { source_timestamp_us: 1.5 })],
    }))).toThrow(/source_timestamp_us/)
    expect(() => decodeGuiDataPage(page({
      frames: [frame(1, [1, 2], { source_timestamp_us: 0x100000000 })],
    }))).toThrow(/source_timestamp_us/)
  })
})
