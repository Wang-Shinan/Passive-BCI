import { afterEach, expect, it, vi } from 'vitest'
import { OmniWsClient } from './client'

class Socket {
  static instances: Socket[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(_url: string) { Socket.instances.push(this) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Socket.instances = [] })

it.each([true, false])('keeps the correct transport failure after socket close (native=%s)', native => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  const onStatus = vi.fn()
  const client = new OmniWsClient({ native, url: 'ws://localhost:9876/v1/stream', onStatus })
  client.connect()
  const socket = Socket.instances[0]
  socket.onerror!()
  socket.onclose!()
  expect(onStatus.mock.calls.at(-1)?.[0]).toBe('error')
  expect(onStatus.mock.calls.at(-1)?.[1]).toContain(native ? '原生 WebSocket' : 'LSL 桥接')
  expect(onStatus.mock.calls.at(-1)?.[1]).toContain('9876')
  if (native) expect(onStatus.mock.calls.flat().join(' ')).not.toContain('LSL')
  client.disconnect()
})

it('ignores stale close events after reconnect and reports native stream disconnection', () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  const onStatus = vi.fn()
  const client = new OmniWsClient({ native: true, onStatus })
  client.connect()
  const old = Socket.instances[0]
  client.connect()
  old.onclose!()
  expect(onStatus.mock.calls.at(-1)?.[0]).toBe('connecting')
  const current = Socket.instances[1]
  current.onmessage!({ data: JSON.stringify({ type: 'eeg', sample_rate_hz: 250, channel_names: ['CH1'],
    frames: [{ sequence: 1, values_uv: [1], valid: true, mode: 0, source_timestamp_ms: null }] }) })
  expect(onStatus.mock.calls.at(-1)?.[0]).toBe('live')
  current.onclose!()
  expect(onStatus.mock.calls.at(-1)).toEqual(['closed', 'OmniBCI 原生 WebSocket连接已断开'])
  client.disconnect()
})
