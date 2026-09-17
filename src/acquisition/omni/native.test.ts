import { afterEach, expect, it, vi } from 'vitest'
import { decodeNativeEeg, sendNativeTrigger } from './native'
import { nbackTriggerCode } from '../../experiments/nback/triggers'

afterEach(() => vi.unstubAllGlobals())
it('decodes documented native packets and preserves sequence, source times and triggers', () => {
  const frame = { sequence: 123, values_uv: [1.2, -.4], raw_counts: [123, -42], valid: true, mode: 1,
    status: [0, 0, 0], source_timestamp_ms: null, triggers: [42] }
  const packet = { type: 'eeg', sample_rate_hz: 250, channel_names: ['CH1', 'CH2'], frames: [frame] }
  const data = decodeNativeEeg(JSON.stringify(packet))
  expect(data.sequence[0]).toBe(123)
  expect(data.nativeFrames).toEqual([frame])
  expect(data.lsl).toBeUndefined()
  expect(data.values[0]).toBeCloseTo(1.2)
  expect(() => decodeNativeEeg(JSON.stringify({ ...packet, frames: [{ ...frame, values_uv: [1] }] }))).toThrow()
})
it('sends only code and label using the documented u16 range', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ accepted: true, session_id: 's', code: 65535,
    label: 'test', host_time: '2026-09-17T16:00:00+08:00', sequence: 123, sample_index: 678 })))
  vi.stubGlobal('fetch', fetcher)
  await expect(sendNativeTrigger(65535, 'test')).resolves.toHaveProperty('sample_index', 678)
  expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ code: 65535, label: 'test' })
  await expect(sendNativeTrigger(65536, 'test')).rejects.toThrow()
})
it('does not retry rejected or ambiguous trigger requests', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: '当前未在录制' }), { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(sendNativeTrigger(0, '')).rejects.toThrow('当前未在录制')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('distinguishes warmup, target and non-target N-back stimuli', () => {
  expect(nbackTriggerCode('stimulus_onset', { scored: false }, 2)).toBe(112)
  expect(nbackTriggerCode('stimulus_onset', { scored: true, target: true }, 2)).toBe(132)
  expect(nbackTriggerCode('stimulus_onset', { scored: true, target: false }, 2)).toBe(122)
  expect(nbackTriggerCode('stimulus_offset', { scored: true, target: false }, 2)).toBe(152)
})
