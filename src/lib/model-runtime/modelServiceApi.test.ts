import { sessionHub } from '../session/sessionHub'
import { acqRuntime } from '../../acquisition/runtime'
import { modelOperation } from './modelOperation'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  applyModelInputFilter, ensureModelService, getAppliedModel, registerModelRuntimeControl,
  selectModelHeadPreference, stopModelService,
} from './modelServiceApi'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
})
afterEach(() => { modelOperation.cancel(); sessionHub.detach(); vi.unstubAllGlobals() })
it('runs REVE on browser windows when the SDK acquisition uses Flex Ver2', async () => {
  const previous = { device: acqRuntime.device, omniLink: acqRuntime.omniLink, omniFlexVer2: acqRuntime.omniFlexVer2 }
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true })))
  vi.stubGlobal('fetch', fetcher)
  try {
    acqRuntime.device = 'omni'
    acqRuntime.omniLink = 'sdk'
    acqRuntime.omniFlexVer2 = { enabled: true, channelNames: [] }
    await ensureModelService({ backend: 'reve' })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).not.toHaveProperty('omniSource')
  } finally {
    Object.assign(acqRuntime, previous)
  }
})

it('uses the saved head when experiments auto-start REVE, but respects an explicit default', async () => {
  selectModelHeadPreference('smr_control', 'chosen.pt')
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    new Response(JSON.stringify({ ok: true, headId: JSON.parse(String(init.body)).headId })))
  vi.stubGlobal('fetch', fetcher)
  await ensureModelService({ task: 'smr_control' })
  await ensureModelService({ task: 'smr_control', headId: '' })
  const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
  expect(JSON.parse(calls[0]![1].body as string).headId).toBe('chosen.pt')
  expect(JSON.parse(calls[1]![1].body as string).headId).toBe('')
})

it.each([null, 'other.pt'])('rejects an explicit head when the service reports %s', async headId => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, headId }))))
  await expect(ensureModelService({ task: 'smr_control', headId: 'chosen.pt' }))
    .rejects.toThrow('模型服务没有确认载入指定分类头 chosen.pt')
})

it('allows choosing and applying a model with an active session', async () => {
  sessionHub.attach({ id: 'test-recording', rel: 'recordings/test' })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, headId: 'gaze-smr/old/head.pt' })))
  vi.stubGlobal('fetch', fetcher)
  expect(() => selectModelHeadPreference('smr_control', 'other.pt')).not.toThrow()
  await ensureModelService({ task: 'gaze_smr', headId: 'gaze-smr/old/head.pt' })
  expect(fetcher).toHaveBeenCalled()
})

it('applies the shared REVE filter while leaving the active recording open', async () => {
  const recording = vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
  const stop = vi.spyOn(acqRuntime.recorder, 'stop').mockResolvedValue(null)
  const current = { ok: true, running: true, owned: true, backend: 'reve', reveFilterMode: 'pretraining' }
  const fetcher = vi.fn(async (url: string, options?: RequestInit) =>
    new Response(JSON.stringify(url.endsWith('/filter') ? { ...current, ...JSON.parse(String(options?.body)) } : current)))
  vi.stubGlobal('fetch', fetcher)
  const onApplied = vi.fn()
  try {
    await applyModelInputFilter({ reveFilterMode: 'none' }, onApplied)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/model-service/filter')
    expect(getAppliedModel()?.reveFilterMode).toBe('none')
    expect(onApplied).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
  } finally {
    recording.mockRestore()
    stop.mockRestore()
  }
})
it('preserves explicit historical gaze selection and an explicit active default', async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ gaze_smr: 'gaze-smr/old/head.pt' }) })
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    new Response(JSON.stringify({ ok: true, headId: JSON.parse(String(init.body)).headId })))
  vi.stubGlobal('fetch', fetcher)
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
