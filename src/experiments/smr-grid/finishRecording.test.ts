import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ recording: false, stop: vi.fn(), flush: vi.fn(), detach: vi.fn() }))
vi.mock('../../lib/session/recordControl', () => ({
  recorderIsActive: () => mocks.recording,
  stopExperimentRecording: mocks.stop,
}))
vi.mock('../../lib/session/sessionHub', () => ({ sessionHub: { flush: mocks.flush, detach: mocks.detach } }))
import { finishGridRecording } from './finishRecording'

beforeEach(() => { vi.resetAllMocks(); mocks.recording = false })

it('flushes the owning recorder before checking the server and coalesces repeated requests', async () => {
  const order: string[] = []
  mocks.recording = true
  mocks.stop.mockImplementation(async () => { order.push('stop'); mocks.recording = false; return { ok: true, message: 'saved' } })
  mocks.flush.mockImplementation(async () => { order.push('flush') })
  vi.stubGlobal('fetch', vi.fn(async () => { order.push('check'); return Response.json({ ok: true, id: null }) }))
  const first = finishGridRecording(), second = finishGridRecording()
  expect(first).toBe(second)
  await first
  expect(order).toEqual(['stop', 'flush', 'check', 'check'])
  expect(mocks.detach).toHaveBeenCalledOnce()
})

it('preserves a remote recording as interrupted and verifies it is closed', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, id: 'other' }))
    .mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ ok: true, id: null }))
  vi.stubGlobal('fetch', fetcher)
  await finishGridRecording()
  expect(fetcher.mock.calls[1]).toEqual(['/api/record/other/finish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"incomplete":true}',
  }])
  expect(mocks.detach).toHaveBeenCalledOnce()
})

it('keeps the model locked if saving fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ ok: true, id: 'other' }))
    .mockResolvedValueOnce(new Response('', { status: 500 })))
  await expect(finishGridRecording()).rejects.toThrow('保存未完成')
  expect(mocks.detach).not.toHaveBeenCalled()
})
