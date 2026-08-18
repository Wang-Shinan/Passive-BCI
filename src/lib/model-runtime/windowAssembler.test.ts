import { describe, expect, it } from 'vitest'
import { ModelWindowAssembler, type ModelSourceBatch } from './windowAssembler'

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

  it('starts a new segment after packet loss and never spans the gap', () => {
    const assembler = new ModelWindowAssembler({ windowSec: 1, stepSec: 0.5 })
    const first = assembler.push(batch([1, 10, 2, 20, 3, 30, 4, 40]))
    const afterGap = assembler.push(
      batch([5, 50, 6, 60], { packetLoss: 1, packetCount: 2 }),
    )
    expect(afterGap).toHaveLength(0)

    const completed = assembler.push(
      batch([7, 70, 8, 80], { packetLoss: 1, packetCount: 3 }),
    )
    expect(completed).toHaveLength(1)
    expect(completed[0]!.header.segment_id).not.toBe(first[0]!.header.segment_id)
    expect([...new Float32Array(completed[0]!.payload)]).toEqual([
      5, 6, 7, 8,
      50, 60, 70, 80,
    ])
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
    assembler.push(batch([5, 50, 6, 60, 7, 70, 8, 80], { packetLoss: 1, packetCount: 2 }))
    const afterGap = assembler.push(
      batch([9, 90, 10, 100, 11, 110, 12, 120], { packetLoss: 1, packetCount: 3 }),
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
})
