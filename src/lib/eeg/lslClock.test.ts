import { afterEach, expect, it } from 'vitest'
import { LslClock, lslClock } from './lslClock'
import { SampleClock } from './sampleClock'
import { BinRecorder, type RecordFinishExtra } from '../../acquisition/session/recorder'

afterEach(() => lslClock.reset())
it('maps browser events via a four-timestamp exchange and expires old mappings', () => {
  const clock = new LslClock()
  clock.observe(1000, 1010, 100.004, 100.006)
  expect(clock.mapping(1010)?.offsetMs).toBeCloseTo(99000)
  expect(clock.mapping(1010)?.rttMs).toBeCloseTo(8)
  clock.observe(2000, 2100, 101.050, 101.050)
  expect(clock.mapping(2100)?.rttMs).toBeCloseTo(8)
  expect(clock.mapping(40000)).toBeNull()
})
it('uses corrected LSL sample time without 32-bit timestamp wrapping', () => {
  lslClock.observe(1000, 1010, 5000000.004, 5000000.006)
  const clock = new SampleClock()
  clock.noteBatch({ samples: 2, sampleRate: 250, arrivalNowMs: 1100,
    lsl: { timestampsSec: [4999999.976, 4999999.980], correctionSec: .020, correctionAtSec: 5000000, streamId: 's' } })
  const event = clock.snapshot(1120)!
  expect(event.source).toBe('lsl')
  expect(event.acquiredNowMs).toBeCloseTo(1000)
  expect(event.lsl?.eventLocalSec).toBeCloseTo(5000000.120)
  expect(event.lsl?.lastSourceTimestampSec).toBe(4999999.980)
  expect(clock.snapshot(50000)?.lsl?.eventLocalSec).toBeNull()
})
it('retains all timestamp batches beyond the live clock ring with exact byte offsets', async () => {
  let saved: RecordFinishExtra | undefined
  const recorder = new BinRecorder({ createSink: async () => ({ kind: 'memory', write: async () => {},
    finish: async extra => { saved = extra; return { name: 'test.bin' } }, abort: async () => {} }) })
  await recorder.start()
  for (let i = 0; i < 1100; i++) recorder.append(new Uint8Array(64), {
    timestampsSec: [100 + i * .008, 100.004 + i * .008], correctionSec: 0, correctionAtSec: 100, streamId: 's' })
  await recorder.stop()
  expect(saved?.lslBatches?.filter(row => row.type === 'lsl_timestamps')).toHaveLength(1100)
  expect(saved?.lslBatches?.at(-1)?.byteOffset).toBe(1099 * 64)
  expect(saved?.lslBatches?.at(-1)?.byteLength).toBe(64)
})
