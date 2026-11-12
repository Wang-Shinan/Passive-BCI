import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recorderIsActive, startExperimentRecording, stopExperimentRecording } = vi.hoisted(() => ({
  recorderIsActive: vi.fn(),
  startExperimentRecording: vi.fn(),
  stopExperimentRecording: vi.fn(),
}))
vi.mock('../../lib/session/recordControl', () => ({
  recorderIsActive,
  startExperimentRecording,
  stopExperimentRecording,
  canStartExperimentRecording: vi.fn(),
}))

import { attachFocusRecording } from './recording'

const diskOk = { ok: true, message: '已在录制中，本局事件会写入当前会话', rel: 'session/x', sink: 'disk' }

beforeEach(() => {
  vi.clearAllMocks()
  startExperimentRecording.mockResolvedValue(diskOk)
})

describe('attachFocusRecording', () => {
  it('reuses an already-active recorder: attached but not owned', async () => {
    recorderIsActive.mockReturnValue(true)
    const result = await attachFocusRecording('S01', 42)
    expect(recorderIsActive).toHaveBeenCalledTimes(1)
    expect(startExperimentRecording).toHaveBeenCalledWith({ experiment: 'focus', subjectId: 'S01', seed: 42 })
    expect(result.attached).toBe(true)
    expect(result.owns).toBe(false)
    expect(stopExperimentRecording).not.toHaveBeenCalled()
  })
  it('starts a fresh recorder: attached and owned', async () => {
    recorderIsActive.mockReturnValue(false)
    const result = await attachFocusRecording('S01', 42)
    expect(result.attached).toBe(true)
    expect(result.owns).toBe(true)
  })
  it('a failed start attaches nothing and owns nothing even when idle', async () => {
    recorderIsActive.mockReturnValue(false)
    startExperimentRecording.mockResolvedValue({ ok: false, message: '请先在采集页连接设备并点「开始采集」' })
    const result = await attachFocusRecording('S01', 42)
    expect(result.attached).toBe(false)
    expect(result.owns).toBe(false)
  })
  it('a reused recorder that fails to expose disk+rel is not attached and never owned', async () => {
    recorderIsActive.mockReturnValue(true)
    startExperimentRecording.mockResolvedValue({ ok: true, message: '已在录制中', rel: undefined, sink: undefined })
    const result = await attachFocusRecording('S01', 42)
    expect(result.attached).toBe(false)
    expect(result.owns).toBe(false)
  })
  it('an unusable fresh start is still owned so the caller can clean it up', async () => {
    recorderIsActive.mockReturnValue(false)
    startExperimentRecording.mockResolvedValue({ ok: true, message: '已开始', rel: 'session/y', sink: 'download' })
    const result = await attachFocusRecording('S01', 42)
    expect(result.attached).toBe(false)
    expect(result.owns).toBe(true)
  })
})
