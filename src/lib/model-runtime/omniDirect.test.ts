import { afterEach, expect, it, vi } from 'vitest'
import { parseServerMessage } from './contracts'

vi.mock('../../acquisition/runtime', () => ({ subscribeRawBridgeBatches: vi.fn(), acqRuntime: { omniLink: 'sdk' } }))
vi.mock('./modelServiceApi', () => ({
  modelServiceStatus: vi.fn(async () => ({ running: true })),
  registerModelRuntimeControl: vi.fn(),
  modelConfigurationLocked: vi.fn(() => false),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks() })

const hello = { type: 'hello', schema_version: 1, input: { source: 'omni-sdk', window_sec: 2, step_sec: 0.1 } }
const prediction = {
  type: 'prediction', schema_version: 1, request_id: 'sdk-1', observation_id: 'o1',
  window_id: 1, segment_id: 'sdk-segment', class_id: 0, class_name: 'left',
  class_names: ['left', 'right'], probabilities: [0.8, 0.2], confidence: 0.8,
  prepare_latency_ms: 2, inference_latency_ms: 10, source_latency_ms: 35,
  source_dropped_windows: 3,
}

it('parses SDK source and host delivery latency without inventing missing values', () => {
  expect(parseServerMessage(JSON.stringify(hello))).toMatchObject({ input_source: 'omni-sdk' })
  expect(parseServerMessage(JSON.stringify(prediction))).toMatchObject({ source_latency_ms: 35, source_dropped_windows: 3 })
  expect(parseServerMessage(JSON.stringify({ ...prediction, source_latency_ms: -1 }))).toHaveProperty('source_latency_ms', undefined)
})

it('receives direct predictions, suppresses browser EEG, clears stale results at a source gap', async () => {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    readyState = 1
    bufferedAmount = 0
    binaryType = ''
    onclose = null
    onerror = null
    onopen = null
    onmessage: ((event: { data: string }) => void) | null = null
    send = vi.fn()
    constructor() { sockets.push(this) }
    close() {}
  }
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('WebSocket', FakeSocket)
  const { modelRuntimeHub: hub } = await import('./modelRuntimeHub')
  const { subscribeRawBridgeBatches } = await import('../../acquisition/runtime')
  hub.setEnabled(true)
  const ws = sockets[0]!
  const onBatch = vi.mocked(subscribeRawBridgeBatches).mock.calls[0]![0]
  // SDK batches must not get forwarded to a previously running browser-input model.
  onBatch({ device: 'omni' } as Parameters<typeof onBatch>[0])
  expect(ws.send).not.toHaveBeenCalled()
  ws.onmessage!({ data: JSON.stringify(hello) })
  onBatch({ device: 'omni' } as Parameters<typeof onBatch>[0])
  expect(ws.send).not.toHaveBeenCalled()
  ws.onmessage!({ data: JSON.stringify(prediction) })
  expect(hub.snapshot.sourceCompatible).toBe(true)
  expect(hub.snapshot.p50LatencyMs).toBe(35)
  expect(hub.snapshot.droppedWindows).toBe(3)
  ws.onmessage!({ data: JSON.stringify({ type: 'error', code: 'source_reset', message: 'gap' }) })
  expect(hub.snapshot.latestPrediction).toBeNull()
  expect(hub.snapshot.sourceCompatible).toBe(false)
  hub.setEnabled(false)
})
