import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acqRuntime, beginRawBridgeStream, ingestBridgeToHub, subscribeRawBridgeBatches, type BridgeBatch, type RawBridgeBatch } from './runtime'
import { liveEegHub } from '../lib/eeg/liveHub'
import { sampleClock } from '../lib/eeg/sampleClock'
import { resetCatchup, setCatchupClock } from './liveCatchup'

const CHANNELS_N = 32
const FS = 250
const NAMES = Array.from({ length: CHANNELS_N }, (_, i) => `Ch${i + 1}`)

function makeBatch(n: number, offset = 0, extra?: Partial<BridgeBatch>): BridgeBatch {
  const values = new Float32Array(n * CHANNELS_N)
  for (let s = 0; s < n; s++) {
    for (let c = 0; c < CHANNELS_N; c++) values[s * CHANNELS_N + c] = offset + s + c / 1000
  }
  return {
    values, samples: n, channels: CHANNELS_N, sampleRate: FS, channelNames: NAMES,
    unit: 'uV', packetLoss: 0, packetCount: 1, arrivalNowMs: performance.now(), ...extra,
  }
}

const waitForIndex = (expected: number) =>
  vi.waitFor(() => expect(sampleClock.snapshot()?.sampleIndex).toBe(expected), { timeout: 1000, interval: 5 })

describe('off-UI bridge ingest path', () => {
  let saved: { streaming: boolean; impedanceActive: boolean; device: typeof acqRuntime.device; status: typeof acqRuntime.status; ui: typeof acqRuntime.ui }
  let appendSpy: ReturnType<typeof vi.spyOn>
  let recordingSpy: ReturnType<typeof vi.spyOn>
  let appendedBytes = 0
  let appendedCalls = 0
  let rawBatches: RawBridgeBatch[] = []
  let unsub: (() => void) | null = null

  beforeEach(() => {
    saved = {
      streaming: acqRuntime.streaming,
      impedanceActive: acqRuntime.impedanceActive,
      device: acqRuntime.device,
      status: acqRuntime.status,
      ui: acqRuntime.ui,
    }
    acqRuntime.streaming = true
    acqRuntime.impedanceActive = false
    acqRuntime.device = 'omni'
    acqRuntime.status = 'streaming'
    acqRuntime.ui = null
    resetCatchup()
    setCatchupClock(FS)
    liveEegHub.configure({ channelNames: NAMES, sampleRate: FS, device: 'omni' })
    liveEegHub.markStreaming()
    appendedBytes = 0
    appendedCalls = 0
    appendSpy = vi.spyOn(acqRuntime.recorder, 'append').mockImplementation((bytes: Uint8Array) => {
      appendedCalls += 1
      appendedBytes += bytes.byteLength
    })
    recordingSpy = vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    rawBatches = []
    unsub = subscribeRawBridgeBatches((b) => rawBatches.push(b))
  })

  afterEach(() => {
    unsub?.()
    unsub = null
    appendSpy.mockRestore()
    recordingSpy.mockRestore()
    acqRuntime.streaming = saved.streaming
    acqRuntime.impedanceActive = saved.impedanceActive
    acqRuntime.device = saved.device
    acqRuntime.status = saved.status
    acqRuntime.ui = saved.ui
    liveEegHub.markIdle()
    resetCatchup()
  })

  it('delivers every queued row to clock, recorder, ring and raw listeners', async () => {
    beginRawBridgeStream()
    const BATCHES = 40
    const PER = 25
    for (let b = 0; b < BATCHES; b++) ingestBridgeToHub(makeBatch(PER, b * 100))
    await waitForIndex(BATCHES * PER)

    expect(sampleClock.snapshot()?.sampleIndex).toBe(BATCHES * PER)
    expect(appendedCalls).toBe(BATCHES)
    expect(appendedBytes).toBe(BATCHES * PER * CHANNELS_N * 4)
    expect(liveEegHub.filled).toBe(BATCHES * PER)
    expect(rawBatches).toHaveLength(BATCHES)
    expect(rawBatches.reduce((sum, b) => sum + b.samples, 0)).toBe(BATCHES * PER)
    expect(rawBatches[0]?.device).toBe('omni')

    const ring = liveEegHub.ring
    const lastIdx = (ring.writeHead - 1 + ring.capacity) % ring.capacity
    const lastSampleOffset = (BATCHES - 1) * 100 + (PER - 1)
    expect(ring.buffers[0]?.[lastIdx]).toBeCloseTo(lastSampleOffset)
    expect(ring.buffers[5]?.[lastIdx]).toBeCloseTo(lastSampleOffset + 0.005)
  })

  it('counts delivered rows, not sequence numbers, when source sequences gap', async () => {
    ingestBridgeToHub(makeBatch(2, 0, { sequence: new Uint32Array([0, 1]) }))
    ingestBridgeToHub(makeBatch(2, 10, { sequence: new Uint32Array([4, 5]) }))
    await waitForIndex(4)

    // 4 rows delivered → index 4; the source gap must not inflate it to 6
    // and must not pad synthetic rows into the recording.
    expect(sampleClock.snapshot()?.sampleIndex).toBe(4)
    expect(appendedBytes).toBe(4 * CHANNELS_N * 4)
    expect(liveEegHub.filled).toBe(4)
    expect(rawBatches.reduce((sum, b) => sum + b.samples, 0)).toBe(4)
  })

  it('retains rows flagged invalid instead of filtering them out', async () => {
    const flags = new Uint8Array(25).fill(1)
    flags[3] = 0
    flags[17] = 0
    ingestBridgeToHub(makeBatch(25, 0, { validFlags: flags }))
    await waitForIndex(25)

    expect(sampleClock.snapshot()?.sampleIndex).toBe(25)
    expect(appendedBytes).toBe(25 * CHANNELS_N * 4)
    expect(liveEegHub.filled).toBe(25)
  })

  it('counts the clock once per batch when a UI sink is installed, without duplicating delivery', async () => {
    const onBridgeBatch = vi.fn()
    const ui = { onBridgeBatch, onSerialData: vi.fn(), onSerialStatus: vi.fn() }
    acqRuntime.ui = ui
    for (let b = 0; b < 10; b++) ingestBridgeToHub(makeBatch(25, b * 100))
    await waitForIndex(250)

    expect(sampleClock.snapshot()?.sampleIndex).toBe(250)
    expect(onBridgeBatch).toHaveBeenCalledTimes(10)
    expect(rawBatches).toHaveLength(10)
    // Hub append belongs to the UI layer once it owns the batch; the runtime
    // path must not also push (no double count downstream).
    expect(appendedCalls).toBe(0)
    expect(liveEegHub.filled).toBe(0)
  })
})
