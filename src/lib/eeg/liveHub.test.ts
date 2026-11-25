import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveEegHub, LIVE_FRESH_MS, LIVE_STALE_MS } from './liveHub'

afterEach(() => {
  vi.restoreAllMocks()
  liveEegHub.markIdle()
})

function startStream(now: ReturnType<typeof vi.spyOn>) {
  now.mockReturnValue(1_000)
  liveEegHub.configure({
    device: 'neuracle',
    sampleRate: 1000,
    channelNames: ['C3', 'C4'],
  })
  liveEegHub.markStreaming()
  liveEegHub.pushInterleaved(new Float32Array(64), 32, 2)
}

describe('liveEegHub freshness', () => {
  it('stays live through a stalled drain if packets keep arriving', () => {
    const now = vi.spyOn(performance, 'now')
    startStream(now)
    expect(liveEegHub.isFresh()).toBe(true)

    now.mockReturnValue(1_000 + LIVE_STALE_MS + 200)
    liveEegHub.noteArrival()
    expect(liveEegHub.isFresh()).toBe(true)
    expect(liveEegHub.ring.lastSampleAt).toBe(1_000)
    liveEegHub.clearSamples()
    expect(liveEegHub.ring.lastSampleAt).toBe(0)
  })

  it('holds live through a short gap, then marks stale after LIVE_STALE_MS', () => {
    const now = vi.spyOn(performance, 'now')
    startStream(now)

    now.mockReturnValue(1_000 + LIVE_FRESH_MS + 200)
    expect(liveEegHub.isFresh()).toBe(true)

    now.mockReturnValue(1_000 + LIVE_STALE_MS + 200)
    expect(liveEegHub.isFresh()).toBe(false)
  })
})

it('tracks feature exclusions by name and intersects them with bad channels and local subsets', () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  try {
    liveEegHub.configure({ channelNames: ['CH1', 'CH2', 'CH11'] })
    liveEegHub.setBadChannelNames(['CH11'])
    liveEegHub.setFeatureChannelSelection(liveEegHub.channelNames, [true, false, true])
    expect(liveEegHub.featureChannelMask()).toEqual([true, false, false])
    expect(liveEegHub.featureChannelMask(['ch11', 'ch2', 'ch1'], [true, true, false])).toEqual([false, false, false])
    expect([...storage.values()]).toContain('["CH2"]')
    liveEegHub.setFeatureChannelSelection(liveEegHub.channelNames, null)
    expect(liveEegHub.featureChannelMask()).toEqual([true, true, false])
  } finally {
    liveEegHub.setFeatureChannelSelection(liveEegHub.channelNames, null)
    liveEegHub.setBadChannelNames([])
    vi.unstubAllGlobals()
  }
})
