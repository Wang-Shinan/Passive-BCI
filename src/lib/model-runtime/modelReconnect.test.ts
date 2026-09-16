import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../acquisition/runtime', () => ({ subscribeRawBridgeBatches: vi.fn() }))
vi.mock('./modelServiceApi', () => ({
  modelServiceStatus: vi.fn(async () => ({ running: true })),
  registerModelRuntimeControl: vi.fn(),
  modelConfigurationLocked: vi.fn(() => false),
}))

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

it('reconnects after an unexpected close but cancels retry when disabled', async () => {
  vi.useFakeTimers()
  const sockets: FakeSocket[] = []
  class FakeSocket {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    readyState = 1
    binaryType = ''
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
    onerror = null
    onmessage = null
    onopen = null
    constructor(_url: string) { sockets.push(this) }
    close() {}
    send() {}
  }
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('WebSocket', FakeSocket)
  const { modelRuntimeHub: hub } = await import('./modelRuntimeHub')
  hub.setUrl('ws://test-server')
  hub.setEnabled(true)
  expect(sockets).toHaveLength(1)
  sockets[0]!.onclose!({ code: 1006, reason: '', wasClean: false })
  expect(hub.snapshot.latestPrediction).toBeNull()
  await vi.advanceTimersByTimeAsync(2000)
  expect(sockets).toHaveLength(2)
  sockets[1]!.onclose!({ code: 1006, reason: '', wasClean: false })
  hub.setEnabled(false)
  await vi.advanceTimersByTimeAsync(4000)
  expect(sockets).toHaveLength(2)
})
