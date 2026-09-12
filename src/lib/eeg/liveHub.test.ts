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
