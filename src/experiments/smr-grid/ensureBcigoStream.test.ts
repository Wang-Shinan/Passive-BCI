import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fresh: false, mode: 'hello' as 'hello' | 'error', opts: null as any,
  ensure: vi.fn(), begin: vi.fn(), ingest: vi.fn(), disconnect: vi.fn(), markStreaming: vi.fn(), markError: vi.fn() }))
vi.mock('../../acquisition/bridgeApi', () => ({ ensureBridge: h.ensure }))
vi.mock('../../acquisition/runtime', () => ({
  acqRuntime: { streaming: false, device: 'omni', bcigo: null, status: 'idle' },
  beginRawBridgeStream: h.begin, ingestBridgeToHub: h.ingest,
}))
vi.mock('../../lib/eeg/liveHub', () => ({ liveEegHub: {
  isFresh: () => h.fresh, configure: vi.fn(), markStreaming: h.markStreaming,
  markError: h.markError, markConnecting: vi.fn(),
} }))
vi.mock('../../acquisition/bcigo/client', () => ({ BcigoWsClient: class {
  constructor(opts: any) { h.opts = opts }
  disconnect() { h.disconnect() }
  connect() { queueMicrotask(() => h.mode === 'hello'
    ? h.opts.onHello({ sample_rate: 250, channels: Array.from({ length: 32 }, (_, i) => `C${i}`) })
    : h.opts.onStatus('error', 'offline')) }
} }))

import { acqRuntime } from '../../acquisition/runtime'
import { ensureGridBcigoStream } from './ensureBcigoStream'

beforeEach(() => {
  vi.clearAllMocks(); h.fresh = false; h.mode = 'hello'
  Object.assign(acqRuntime, { streaming: false, device: 'omni', bcigo: null, status: 'idle' })
  h.ensure.mockResolvedValue({ ok: true })
})

it('attaches a new tab to BCIGo and enables raw model batches', async () => {
  await ensureGridBcigoStream()
  expect(h.ensure).toHaveBeenCalledWith('bcigo')
  expect(acqRuntime.streaming).toBe(true)
  expect(acqRuntime.device).toBe('bcigo')
  expect(h.begin).toHaveBeenCalledOnce()
  expect(h.opts.onBatch).toBe(h.ingest)
  expect(h.markStreaming).toHaveBeenCalledOnce()
})

it('reuses a fresh same-tab stream and reports connection failures', async () => {
  h.fresh = true; Object.assign(acqRuntime, { streaming: true, device: 'bcigo', bcigo: { disconnect: h.disconnect } })
  await ensureGridBcigoStream()
  expect(h.ensure).not.toHaveBeenCalled()
  h.fresh = false; h.mode = 'error'; acqRuntime.streaming = false
  await expect(ensureGridBcigoStream()).rejects.toThrow('offline')
  expect(acqRuntime.status).toBe('error')
})
