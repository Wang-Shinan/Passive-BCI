import { afterEach, expect, it, vi } from 'vitest'
import { captureSystemClock } from './systemClock'
import { sampleClock } from './sampleClock'
import { SessionLogger } from '../logger'
import { sessionHub } from '../session/sessionHub'
import { BinRecorder, type RecordFinishExtra } from '../../acquisition/session/recorder'

afterEach(() => { vi.restoreAllMocks(); sampleClock.reset() })
it('preserves a wall-clock adjustment independently of monotonic event time', () => {
  vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(12).mockReturnValueOnce(20).mockReturnValueOnce(22)
  vi.spyOn(Date, 'now').mockReturnValueOnce(200000).mockReturnValueOnce(190000)
  const a = captureSystemClock(), b = captureSystemClock()
  expect(b.wallUnixMs - a.wallUnixMs).toBe(-10000)
  expect(b.monotonicMs - a.monotonicMs).toBe(10)
  expect(b.wallReadSpanMs).toBe(2)
  expect(b.monotonicUnixMs).toBe(performance.timeOrigin + 21)
})
it('exports the same dual-clock event with hardware timestamp missing explicitly', () => {
  const receivedClock = captureSystemClock()
  sampleClock.noteBatch({ samples: 2, sampleRate: 250, arrivalNowMs: receivedClock.monotonicMs, receivedClock,
    native: { sequence: 5, sourceTimestampMs: null } })
  const send = vi.spyOn(sessionHub, 'logEvent').mockImplementation(() => {})
  const logger = new SessionLogger('nback', 'TEST')
  logger.log('stimulus_onset')
  const event = logger.getEvents()[0]!
  expect(event.systemClock).toEqual(send.mock.calls[0]![0].systemClock)
  expect(event.systemClock?.wallUnixMs).toBeGreaterThan(0)
  expect(event.data?.eeg).toMatchObject({ native: { sequence: 5, sourceTimestampMs: null }, receivedClock })
  expect(JSON.parse(logger.toJSON()).events[0].systemClock).toEqual(event.systemClock)
  expect(logger.toCSV()).toContain('wall_unix_ms,monotonic_ms,time_origin_unix_ms')
})
it('retains fractional per-frame hardware timestamps beside host receipt time', async () => {
  let saved: RecordFinishExtra | undefined
  const recorder = new BinRecorder({ createSink: async () => ({ kind: 'memory', write: async () => {},
    finish: async extra => { saved = extra; return { name: 'test.bin' } }, abort: async () => {} }) })
  const receivedClock = captureSystemClock()
  const frames = [123.456789, 127.456789].map((source_timestamp_ms, i) => ({ sequence: i, values_uv: [1, 2],
    valid: true, mode: 1, source_timestamp_ms }))
  await recorder.start()
  recorder.append(new Uint8Array(16), undefined, frames, receivedClock)
  await recorder.stop()
  const row = saved!.lslBatches!.find(row => row.type === 'omni_native_frames')!
  expect(row.nativeFrames).toEqual(frames)
  expect(row.receivedClock).toEqual(receivedClock)
  expect(row.systemClock).toHaveProperty('wallUnixMs')
  expect(row.byteOffset).toBe(0)
})

it('records only the first nonempty receipt and resets for each recording', async () => {
  const results: RecordFinishExtra[] = []
  const recorder = new BinRecorder({ createSink: async () => ({ kind: 'memory', write: async () => {},
    finish: async extra => { results.push(extra!); return { name: 'test.bin' } }, abort: async () => {} }) })
  const first = { ...captureSystemClock(), wallUnixMs: 1700000000123, monotonicMs: 321 }
  const later = { ...first, wallUnixMs: first.wallUnixMs + 1000, monotonicMs: 1321 }
  await recorder.start()
  recorder.append(new Uint8Array(), undefined, undefined, later)
  recorder.append(new Uint8Array(16), undefined, undefined, first)
  recorder.append(new Uint8Array(16), undefined, undefined, later)
  await recorder.stop()
  expect(results[0].firstDataReceived).toEqual({ systemClock: first, capturePoint: 'transport_receive', byteOffset: 0 })
  expect(results[0].lslBatches?.filter(row => row.type === 'first_data_received')).toHaveLength(1)
  await recorder.start()
  recorder.append(new Uint8Array(16), undefined, undefined, later)
  await recorder.stop()
  expect(results[1].firstDataReceived?.systemClock).toEqual(later)
  await recorder.start()
  recorder.append(new Uint8Array(16))
  await recorder.stop()
  expect(results[2].firstDataReceived?.capturePoint).toBe('recorder_append')
  expect(results[2].firstDataReceived?.systemClock.wallUnixMs).toBeGreaterThan(0)
})
