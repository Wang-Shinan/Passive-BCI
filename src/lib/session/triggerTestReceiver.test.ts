import { afterEach, expect, it, vi } from 'vitest'
import { installTriggerTestReceiver } from './triggerTestReceiver'
import { sessionHub } from './sessionHub'
import { sampleClock } from '../eeg/sampleClock'

const recorder = vi.hoisted(() => ({ recording: true }))
vi.mock('../../acquisition/runtime', () => ({ acqRuntime: { recorder } }))
vi.mock('./sessionHub', () => ({ sessionHub: { info: { active: true, id: 'a', rel: 'recordings/a' },
  logEvent: vi.fn(), flush: vi.fn(async () => {}) } }))
vi.mock('../eeg/sampleClock', () => ({ sampleClock: { snapshot: vi.fn(() => ({
  native: { sequence: 123 }, arrivalNowMs: performance.now(), sampleRate: 250, sampleIndex: 10 })) } }))

class Socket {
  static OPEN = 1
  static latest: Socket
  readyState = 1
  onmessage!: (event: { data: string }) => Promise<void>
  send = vi.fn()
  close = vi.fn()
  constructor() { Socket.latest = this }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); recorder.recording = true })

it('persists the exact receiver timestamp and sample snapshot and rejects duplicates', async () => {
  vi.stubGlobal('location', { hostname: 'localhost' })
  vi.stubGlobal('WebSocket', Socket)
  const dispose = installTriggerTestReceiver()
  const event = { data: JSON.stringify({ type: 'trigger_test', code: 65533, eventId: 'TRIGGER_TEST_unit_1' }) }
  await Socket.latest.onmessage(event)
  const record = vi.mocked(sessionHub.logEvent).mock.calls[0][0]
  const ack = JSON.parse(Socket.latest.send.mock.calls[0][0])
  expect(ack.accepted).toBe(true)
  expect(ack.systemClock).toEqual(record.systemClock)
  expect(ack.eeg).toEqual(record.eeg)
  expect(record.eeg?.native?.sequence).toBe(123)
  expect(sessionHub.flush).toHaveBeenCalledOnce()
  await Socket.latest.onmessage(event)
  expect(sessionHub.logEvent).toHaveBeenCalledOnce()
  expect(JSON.parse(Socket.latest.send.mock.calls[1][0]).accepted).toBe(false)
  dispose()
})

it('does not acknowledge storage when browser is not recording', async () => {
  vi.stubGlobal('location', { hostname: 'localhost' })
  vi.stubGlobal('WebSocket', Socket)
  recorder.recording = false
  const dispose = installTriggerTestReceiver()
  await Socket.latest.onmessage({ data: JSON.stringify({ type: 'trigger_test', code: 65533, eventId: 'TRIGGER_TEST_unit_2' }) })
  expect(sessionHub.logEvent).not.toHaveBeenCalled()
  expect(JSON.parse(Socket.latest.send.mock.calls[0][0]).accepted).toBe(false)
  expect(sampleClock.snapshot).toHaveBeenCalled()
  dispose()
})
