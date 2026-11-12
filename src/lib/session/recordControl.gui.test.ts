import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acqRuntime } from '../../acquisition/runtime'
import { liveEegHub } from '../eeg/liveHub'
import { sessionHub } from './sessionHub'
import { startExperimentRecording } from './recordControl'

const NAMES32 = Array.from({ length: 32 }, (_, i) => `CH${i + 1}`)

describe('startExperimentRecording omni metadata', () => {
  let saved: { streaming: boolean; device: typeof acqRuntime.device; omniLink: typeof acqRuntime.omniLink; status: typeof acqRuntime.status }
  let startSpy: ReturnType<typeof vi.spyOn>
  let bindSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    saved = { streaming: acqRuntime.streaming, device: acqRuntime.device, omniLink: acqRuntime.omniLink, status: acqRuntime.status }
    acqRuntime.streaming = true
    acqRuntime.device = 'omni'
    acqRuntime.status = 'streaming'
    liveEegHub.configure({ device: 'omni', sampleRate: 250, channelNames: [...NAMES32] })
    liveEegHub.markStreaming()
    for (let i = 0; i < 16; i++) liveEegHub.pushFrame(new Array(32).fill(i))
    startSpy = vi.spyOn(acqRuntime.recorder, 'start').mockResolvedValue('disk')
    bindSpy = vi.spyOn(sessionHub, 'bindMeta')
  })

  afterEach(() => {
    startSpy.mockRestore()
    bindSpy.mockRestore()
    acqRuntime.streaming = saved.streaming
    acqRuntime.device = saved.device
    acqRuntime.omniLink = saved.omniLink
    acqRuntime.status = saved.status
    liveEegHub.markIdle()
  })

  it('records the gui link provenance into the disk meta', async () => {
    acqRuntime.omniLink = 'gui'
    const result = await startExperimentRecording({ experiment: 'focus', subjectId: 'S01', seed: 1 })
    expect(result.ok).toBe(true)
    const meta = startSpy.mock.calls[0]?.[0]?.meta as Record<string, unknown>
    expect(meta.omniLink).toBe('gui')
    expect(meta.guiEndpoint).toBe('http://127.0.0.1:8766')
    expect(meta.channels).toBe(32)
    expect(meta.channelNames).toEqual(NAMES32)
  })
})
