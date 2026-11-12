import { describe, expect, it } from 'vitest'
import { ModelWindowAssembler, type ModelSourceBatch } from './windowAssembler'
import type { ModelWindowPacket } from './contracts'

function batch(
  values: number[],
  overrides: Partial<ModelSourceBatch> = {},
): ModelSourceBatch {
  return {
    values: new Float32Array(values),
    samples: values.length / 2,
    channels: 2,
    sampleRate: 4,
    channelNames: ['C3', 'C4'],
    unit: 'uV',
    packetLoss: 0,
    packetCount: 1,
    device: 'neuracle',
    streamId: 1,
    ...overrides,
  }
}

describe('ModelWindowAssembler', () => {
  it('emits exact overlapping CT windows', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))

    expect(first).toHaveLength(1)
    expect(first[0]!.header).toMatchObject({
      layout: 'CT',
      channels: 2,
      samples: 4,
      sample_count: 4,
      start_time_sec: 0,
      end_time_sec: 1,
    })
    expect([...new Float32Array(first[0]!.payload)]).toEqual([
      1, 2, 3, 4,
      10, 20, 30, 40,
    ])

    const second = assembler.push(
      batch([5, 50, 6, 60], { packetCount: 2 }),
    )
    expect(second).toHaveLength(1)
    expect([...new Float32Array(second[0]!.payload)]).toEqual([
      3, 4, 5, 6,
      30, 40, 50, 60,
    ])
    expect(second[0]!.header.segment_id).toBe(first[0]!.header.segment_id)
    expect(second[0]!.header.window_id).toBe(first[0]!.header.window_id + 1)
  })

  it('retains received samples across packet loss and reports the cumulative counter', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))
    // packetLoss=1 is a cumulative source counter — it no longer breaks the window
    const afterLoss = assembler.push(
      batch([5, 50, 6, 60], { packetLoss: 1, packetCount: 2 }),
    )
    expect(afterLoss).toHaveLength(1)
    expect(afterLoss[0]!.header.segment_id).toBe(first[0]!.header.segment_id)
    expect([...new Float32Array(afterLoss[0]!.payload)]).toEqual([
      3, 4, 5, 6,
      30, 40, 50, 60,
    ])
    expect(afterLoss[0]!.header.source_quality).toEqual({
      sample_timing: 'received_samples',
      gap_policy: 'retain_received_samples',
      reported_missing_samples_total: 1,
    })

    const next = assembler.push(
      batch([7, 70, 8, 80], { packetLoss: 1, packetCount: 3 }),
    )
    expect(next).toHaveLength(1)
    expect(next[0]!.header.segment_id).toBe(first[0]!.header.segment_id)
    expect([...new Float32Array(next[0]!.payload)]).toEqual([
      5, 6, 7, 8,
      50, 60, 70, 80,
    ])
    expect(next[0]!.header.source_quality?.reported_missing_samples_total).toBe(1)
  })

  it('rejects malformed raw batches', () => {
    const assembler = new ModelWindowAssembler()
    expect(() =>
      assembler.push(batch([1, 2], { samples: 2 })),
    ).toThrow(/长度/)
    expect(() =>
      assembler.push(batch([1, 2], { unit: 'V' })),
    ).toThrow(/uV/)
  })

  it('keeps window_id monotonic across segment changes', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))
    const windowOne = first[0]!.header.window_id
    assembler.push(batch([5, 50, 6, 60, 7, 70, 8, 80], { packetCount: 2 }))
    const afterGap = assembler.push(
      batch([9, 90, 10, 100, 11, 110, 12, 120], { packetCount: 3, streamId: 2 }),
    )
    expect(afterGap.length).toBeGreaterThan(0)
    for (const packet of afterGap) {
      expect(packet.header.window_id).toBeGreaterThan(windowOne)
      expect(packet.header.segment_id).not.toBe(first[0]!.header.segment_id)
    }
  })

  it('assigns unique window_id per segment after bumpSegment', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))
    const firstId = first[0]!.header.window_id
    assembler.bumpSegment()
    const second = assembler.push(batch([5, 50, 6, 60, 7, 70, 8, 80], { packetCount: 2 }))
    expect(second).toHaveLength(1)
    expect(second[0]!.header.window_id).toBe(firstId + 1)
    expect(second[0]!.header.segment_id).not.toBe(first[0]!.header.segment_id)
  })

  it('sizes a 2 second window from the configured duration', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 2, stepSec: 0.5 })
    const values: number[] = []
    for (let sample = 1; sample <= 8; sample++) values.push(sample, sample * 10)
    const emitted = assembler.push(batch(values))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.header.samples).toBe(8)
    expect(emitted[0]!.header.start_time_sec).toBe(0)
    expect(emitted[0]!.header.end_time_sec).toBe(2)
  })

  it('preserves buffered samples when the window grows', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))
    expect(assembler.resize(2, 0.5)).toBe(true)
    const emitted = assembler.push(
      batch([5, 50, 6, 60, 7, 70, 8, 80], { packetCount: 2 }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.header.samples).toBe(8)
    expect(emitted[0]!.header.end_time_sec).toBe(2)
    expect(emitted[0]!.header.segment_id).toBe(first[0]!.header.segment_id)
    expect([...new Float32Array(emitted[0]!.payload)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
      10, 20, 30, 40, 50, 60, 70, 80,
    ])
  })

  it('keeps the newest samples when the window shrinks', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 2, stepSec: 0.5 })
    const first = assembler.push(
      batch([1, 10, 2, 20, 3, 30, 4, 40, 5, 50, 6, 60, 7, 70, 8, 80]),
    )
    expect(assembler.resize(1, 0.5)).toBe(true)
    const emitted = assembler.push(
      batch([9, 90, 10, 100], { packetCount: 2 }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.header.samples).toBe(4)
    expect(emitted[0]!.header.segment_id).toBe(first[0]!.header.segment_id)
    expect([...new Float32Array(emitted[0]!.payload)]).toEqual([
      7, 8, 9, 10,
      70, 80, 90, 100,
    ])
  })

  it('applies a step-only resize without clearing the buffer', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))
    expect(assembler.resize(1, 0.25)).toBe(true)
    const emitted = assembler.push(batch([5, 50], { packetCount: 2 }))
    expect(emitted).toHaveLength(1)
    expect([...new Float32Array(emitted[0]!.payload)]).toEqual([
      2, 3, 4, 5,
      20, 30, 40, 50,
    ])
  })

  it('rejects invalid resize contracts', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 2, stepSec: 0.5 })
    expect(assembler.resize(1, 2)).toBe(false)
    expect(assembler.resize(0, 0.5)).toBe(false)
    expect(assembler.windowSec).toBe(2)
    expect(assembler.stepSec).toBe(0.5)
  })

  it('emits at 10 Hz when step is 0.1s', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.1 })
    const values: number[] = []
    for (let sample = 1; sample <= 10; sample++) values.push(sample, sample * 10)
    const first = assembler.push(batch(values, { sampleRate: 10, samples: 10 }))
    expect(first).toHaveLength(1)
    expect(first[0]!.header.samples).toBe(10)
    expect(first[0]!.header.end_time_sec).toBe(1)
    const second = assembler.push(
      batch([11, 110], { sampleRate: 10, samples: 1, packetCount: 2 }),
    )
    expect(second).toHaveLength(1)
    expect(second[0]!.header.start_time_sec).toBeCloseTo(0.1)
    expect(second[0]!.header.end_time_sec).toBeCloseTo(1.1)
  })

  it('emits a first window after 500 received samples even when every batch reports cumulative loss', () => {
    // 250 Hz / 2 s window / 0.1 s step; 20 batches of 25 received samples each,
    // packetLoss increasing on every batch — the starvation scenario that
    // previously reset the assembler before the window ever filled.
    const assembler = new ModelWindowAssembler({ windowSec: 2, stepSec: 0.1 })
    let sample = 0
    const emitted: ModelWindowPacket[] = []
    for (let b = 0; b < 20; b++) {
      const values: number[] = []
      for (let r = 0; r < 25; r++) {
        sample += 1
        values.push(sample, sample * 10)
      }
      emitted.push(...assembler.push(batch(values, {
        sampleRate: 250, samples: 25,
        packetLoss: b, packetCount: b + 1,
      })))
    }
    expect(emitted.length).toBeGreaterThanOrEqual(1)
    const first = emitted[0]!
    // exactly the 500 received samples, CT layout, no padding, same segment
    expect(first.header.samples).toBe(500)
    expect(first.payload.byteLength).toBe(500 * 2 * 4)
    const ch1 = Array.from({ length: 500 }, (_, i) => i + 1)
    const ch2 = ch1.map(v => v * 10)
    expect([...new Float32Array(first.payload)]).toEqual([...ch1, ...ch2])
    expect(first.header.source_quality).toEqual({
      sample_timing: 'received_samples',
      gap_policy: 'retain_received_samples',
      reported_missing_samples_total: 19,
    })
    const seg = first.header.segment_id
    // the next batch slides a full window of the newest 500 received samples
    const slide = assembler.push(batch(
      Array.from({ length: 25 }, (_, i) => (sample + i + 1) * 11 % 97).flatMap((v, i) => [sample + i + 1, v]),
      { sampleRate: 250, samples: 25, packetLoss: 20, packetCount: 21 },
    ))
    expect(slide.length).toBeGreaterThanOrEqual(1)
    expect(slide[0]!.header.segment_id).toBe(seg)
    expect(slide[0]!.header.samples).toBe(500)
    expect(slide[0]!.header.source_quality?.reported_missing_samples_total).toBe(20)
  })

  it('resets the segment when the source packet counter rolls back or stream identity changes', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40], { packetCount: 20 }))
    assembler.push(batch([5, 50, 6, 60], { packetCount: 21 }))
    // counter rollback (source restarted its counter) → new segment
    const afterReset = assembler.push(batch([7, 70, 8, 80, 9, 90, 10, 100], { packetCount: 1 }))
    expect(afterReset).toHaveLength(1)
    expect(afterReset[0]!.header.segment_id).not.toBe(first[0]!.header.segment_id)
    // stream identity change → new segment
    const other = assembler.push(batch([11, 110, 12, 120, 13, 130, 14, 140], { packetCount: 2, streamId: 9 }))
    expect(other[0]!.header.segment_id).not.toBe(afterReset[0]!.header.segment_id)
  })
})
