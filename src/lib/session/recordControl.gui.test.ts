import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acqRuntime } from '../../acquisition/runtime'
import { OMNI_FLEX_VER2_ELECTRODES } from '../../acquisition/omni/flexVer2'
import { liveEegHub } from '../eeg/liveHub'
import { sessionHub } from './sessionHub'
import { startExperimentRecording } from './recordControl'

const NAMES32 = Array.from({ length: 32 }, (_, i) => `CH${i + 1}`)

describe('startExperimentRecording omni metadata', () => {
  let saved: Pick<typeof acqRuntime, 'streaming' | 'device' | 'omniLink' | 'status' | 'omniGuiPort' | 'omniFlexVer2'>
  let startSpy: ReturnType<typeof vi.spyOn>
  let bindSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    saved = { streaming: acqRuntime.streaming, device: acqRuntime.device, omniLink: acqRuntime.omniLink,
      status: acqRuntime.status, omniGuiPort: acqRuntime.omniGuiPort, omniFlexVer2: acqRuntime.omniFlexVer2 }
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
    Object.assign(acqRuntime, saved)
    liveEegHub.markIdle()
  })

  it('records the gui link provenance into the disk meta', async () => {
    acqRuntime.omniLink = 'gui'
    acqRuntime.omniGuiPort = 8769
    const result = await startExperimentRecording({ experiment: 'focus', subjectId: 'S01', seed: 1 })
    expect(result.ok).toBe(true)
    const meta = startSpy.mock.calls[0]?.[0]?.meta as Record<string, unknown>
    expect(meta.omniLink).toBe('gui')
    expect(meta.guiEndpoint).toBe('http://127.0.0.1:8769')
    expect(meta.channels).toBe(32)
    expect(meta.channelNames).toEqual(NAMES32)
  })

  it('records the active REVE projection alongside all raw Omni channels', async () => {
    acqRuntime.omniLink = 'gui'
    acqRuntime.omniFlexVer2 = { enabled: true, channelNames: ['CH18'] }
    await startExperimentRecording({ experiment: 'smr-adapt', subjectId: 'S01' })
    const meta = startSpy.mock.calls[0]?.[0]?.meta
    expect(meta).toMatchObject({ channels: 32, channelNames: NAMES32, reveInput: {
      indices: [17, ...Array.from({ length: 15 }, (_, i) => i + 1)],
      channelNames: OMNI_FLEX_VER2_ELECTRODES.map(item => item.name),
      electrodePositions: OMNI_FLEX_VER2_ELECTRODES.map(item => item.position),
    } })
  })
})
