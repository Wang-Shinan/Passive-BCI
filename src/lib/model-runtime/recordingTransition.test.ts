import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  recorder: { recording: true, restartOptions: { filenamePrefix: 'subject', meta: { sampleRate: 250 } }, stop: vi.fn(), start: vi.fn() },
  runtime: { streaming: true }, bind: vi.fn(), log: vi.fn(), reset: vi.fn(),
}))
vi.mock('../../acquisition/runtime', () => ({ acqRuntime: { get streaming() { return mocks.runtime.streaming }, recorder: mocks.recorder } }))
vi.mock('../session/sessionHub', () => ({ sessionHub: { boundMeta: { subjectId: 'S04', experiment: 'video' }, info: { rel: 'old' }, bindMeta: mocks.bind } }))
vi.mock('../logger', () => ({ SessionLogger: class { log = mocks.log } }))
vi.mock('../eeg/sampleClock', () => ({ sampleClock: { reset: mocks.reset } }))
import { withRecordingTransition } from './recordingTransition'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recorder.recording = true
  mocks.runtime.streaming = true
  mocks.recorder.stop.mockResolvedValue({ rel: 'saved-old' })
  mocks.recorder.start.mockResolvedValue('disk')
})
it('saves before applying and creates a fresh segment with the same subject and device metadata', async () => {
  const order: string[] = []
  mocks.recorder.stop.mockImplementation(async () => { order.push('save'); return { rel: 'saved-old' } })
  mocks.recorder.start.mockImplementation(async () => { order.push('restart'); return 'disk' })
  const signal = new AbortController().signal
  const result = await withRecordingTransition(async () => { order.push('model'); return 42 }, signal)
  expect(result).toBe(42)
  expect(order).toEqual(['save', 'model', 'restart'])
  expect(mocks.recorder.start).toHaveBeenCalledWith(expect.objectContaining({ meta: { sampleRate: 250 } }), signal)
  expect(mocks.bind).toHaveBeenCalledWith({ subjectId: 'S04', experiment: 'video' })
  expect(mocks.reset).toHaveBeenCalledOnce()
})
it('does not start recording on a viewing-only page', async () => {
  mocks.recorder.recording = false
  await withRecordingTransition(async () => true, new AbortController().signal)
  expect(mocks.recorder.stop).not.toHaveBeenCalled()
  expect(mocks.recorder.start).not.toHaveBeenCalled()
})
it('does not change the model when saving fails', async () => {
  mocks.recorder.stop.mockResolvedValue({ error: 'disk full' })
  const action = vi.fn()
  await expect(withRecordingTransition(action, new AbortController().signal)).rejects.toThrow('旧段保存失败')
  expect(action).not.toHaveBeenCalled()
  expect(mocks.recorder.start).not.toHaveBeenCalled()
})
it('retains the saved segment without restarting on model failure', async () => {
  await expect(withRecordingTransition(async () => { throw new Error('load failed') }, new AbortController().signal)).rejects.toThrow('旧段已保存')
  expect(mocks.recorder.start).not.toHaveBeenCalled()
})
it('does not resume after cancellation during loading', async () => {
  const controller = new AbortController()
  await expect(withRecordingTransition(async () => { controller.abort(); return true }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.recorder.start).not.toHaveBeenCalled()
})
it('reports that the new recording failed after a successful model change', async () => {
  mocks.recorder.start.mockRejectedValue(new Error('disk unavailable'))
  await expect(withRecordingTransition(async () => true, new AbortController().signal)).rejects.toThrow('新段录制未成功')
})
