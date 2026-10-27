import { afterEach, expect, it, vi } from 'vitest'

type Batch = {
  device: string
  values: Float32Array
  samples: number
  channels: number
  sampleRate: number
  channelNames: string[]
  unit: string
  streamId: number
}

const captured = vi.hoisted(() => ({ listener: null as null | ((batch: Batch) => void) }))

vi.mock('../../acquisition/runtime', () => ({
  acqRuntime: { omniLink: 'sdk' },
  subscribeRawBridgeBatches: (listener: (batch: Batch) => void) => {
    captured.listener = listener
    return () => {}
  },
}))
vi.mock('./modelServiceApi', () => ({
  modelServiceStatus: vi.fn(async () => ({ running: true })),
  registerModelRuntimeControl: vi.fn(),
  modelConfigurationLocked: vi.fn(() => false),
}))

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 1
  bufferedAmount = 0
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onopen: ((event: unknown) => void) | null = null
  constructor(_url: string) {
    sockets.push(this)
  }
  close() {
    this.readyState = 3
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data)
  }
}

const sockets: FakeSocket[] = []

function hello(acceptsWindowStream?: boolean): string {
  return JSON.stringify({
    type: 'hello',
    schema_version: 1,
    service: 'eegnet-tetris',
    model: { name: 'eegnet', type: 'eegnet', task: 'smr_control' },
    class_names: ['left_hand', 'right_hand', 'tongue', 'rest'],
    online: { model_revision: 'eegnet-smr-random-20261022', strategy: 'full-finetune' },
    input: { window_sec: 2, step_sec: 0.1, slide_sec: 0.1 },
    supports_group_training: true,
    ...(acceptsWindowStream === undefined ? {} : { accepts_window_stream: acceptsWindowStream }),
  })
}

function omniBatch(): Batch {
  const channels = 32
  const samples = 500
  return {
    device: 'omni',
    values: new Float32Array(samples * channels),
    samples,
    channels,
    sampleRate: 250,
    channelNames: Array.from({ length: channels }, (_, index) => `CH${index + 1}`),
    unit: 'uV',
    streamId: 1,
  }
}

async function connect(withHello: string) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('WebSocket', FakeSocket)
  sockets.length = 0
  const { modelRuntimeHub: hub } = await import('./modelRuntimeHub')
  hub.setUrl('ws://test-server')
  hub.setEnabled(true)
  const socket = sockets[0]!
  socket.onopen?.({})
  socket.onmessage?.({ data: withHello })
  return { hub, socket }
}

const kinds = (socket: FakeSocket) =>
  socket.sent.filter((item): item is string => typeof item === 'string').map(item => JSON.parse(item).type as string)

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
  captured.listener = null
})

it('forwards browser windows from the SDK BLE link when the model asks for them', async () => {
  const { hub, socket } = await connect(hello(true))
  expect(hub.snapshot.serviceHello?.accepts_window_stream).toBe(true)
  captured.listener?.(omniBatch())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(kinds(socket)).toContain('window')
  expect(socket.sent.some(item => item instanceof ArrayBuffer)).toBe(true)
})

it('keeps the SDK BLE bypass for relays that consume the stream themselves', async () => {
  const { socket } = await connect(hello())
  captured.listener?.(omniBatch())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(kinds(socket)).not.toContain('window')
})

it('assembles continuous 250 Hz single-sample bursts even when browser timers are delayed', async () => {
  const { hub, socket } = await connect(hello(true))
  vi.useFakeTimers()
  const timer = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay = 0, ...args) =>
    timer(callback, Math.max(8, delay), ...args))
  const batch = { ...omniBatch(), samples: 1 }
  try {
    // Four individual SDK frames per 16 ms, with a busy browser delaying timers.
    for (let sample = 0; sample < 600; sample += 4) {
      for (let offset = 0; offset < 4; offset++) {
        captured.listener?.({ ...batch, values: new Float32Array(32).fill(sample + offset) })
      }
      await vi.advanceTimersByTimeAsync(16)
    }
    expect(hub.snapshot.droppedSourceBatches).toBe(0)
    const payload = socket.sent.find(item => item instanceof ArrayBuffer)
    expect(payload).toBeInstanceOf(ArrayBuffer)
    // The first 2-second window must retain all 500 consecutive samples.
    expect(Array.from(new Float32Array(payload as ArrayBuffer).slice(0, 500)))
      .toEqual(Array.from({ length: 500 }, (_, index) => index))
  } finally {
    hub.disconnect()
  }
})
