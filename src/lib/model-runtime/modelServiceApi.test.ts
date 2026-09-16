import { afterEach, expect, it, vi } from 'vitest'
import { ensureModelService } from './modelServiceApi'

afterEach(() => vi.unstubAllGlobals())
it('uses the saved head when experiments auto-start REVE, but respects an explicit default', async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ smr_control: 'chosen.pt' }) })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
  vi.stubGlobal('fetch', fetcher)
  await ensureModelService({ task: 'smr_control' })
  await ensureModelService({ task: 'smr_control', headId: '' })
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
  expect(JSON.parse(calls[0]![1].body as string).headId).toBe('chosen.pt')
  expect(JSON.parse(calls[1]![1].body as string).headId).toBe('')
})
