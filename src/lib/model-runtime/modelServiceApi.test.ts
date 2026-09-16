import { sessionHub } from '../session/sessionHub'
import { modelOperation } from './modelOperation'
import { afterEach, expect, it, vi } from 'vitest'
import { ensureModelService, stopModelService, selectModelHeadPreference, registerModelRuntimeControl, getAppliedModel } from './modelServiceApi'

afterEach(() => { modelOperation.cancel(); sessionHub.detach(); vi.unstubAllGlobals() })
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

it('blocks both launcher and picker API calls while recording, not only disabled UI buttons', async () => {
  sessionHub.attach({ id: 'test-recording', rel: 'recordings/test' })
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(ensureModelService({ task: 'gaze_smr', headId: 'gaze-smr/old/head.pt' })).rejects.toThrow('录制期间')
  expect(() => selectModelHeadPreference('smr_control', 'other.pt')).toThrow('结束录制')
  expect(fetcher).not.toHaveBeenCalled()
})
it('preserves explicit historical gaze selection and an explicit active default', async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ gaze_smr: 'gaze-smr/old/head.pt' }) })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }))); vi.stubGlobal('fetch', fetcher)
  await ensureModelService({ task: 'gaze_smr' })
  await ensureModelService({ task: 'gaze_smr', headId: '' })
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
  expect(JSON.parse(calls[0]![1].body as string).headId).toBe('gaze-smr/old/head.pt')
  expect(JSON.parse(calls[1]![1].body as string).headId).toBe('')
})
it('emergency stop cancels an in-flight launch and cannot be undone by its late success', async () => {
  let resolve!: (res: Response) => void
  const disabled = vi.fn()
  registerModelRuntimeControl({ suspend: vi.fn(), disable: disabled })
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/ensure')
    ? new Promise<Response>(done => { resolve = done })
    : Promise.resolve(new Response(JSON.stringify({ ok: true, running: false })))))
  const launch = ensureModelService({ task: 'smr_control' }); void launch.catch(() => {})
  sessionHub.attach({ id: 'test-recording', rel: 'recordings/test' })
  await stopModelService()
  resolve(new Response(JSON.stringify({ ok: true, running: true, headId: 'old.pt' })))
  await expect(launch).rejects.toMatchObject({ name: 'AbortError' })
  expect(disabled).toHaveBeenCalledOnce(); expect(getAppliedModel()).toBeNull()
})
