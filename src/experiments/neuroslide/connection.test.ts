import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  snapshot: { url: 'ws://site/ws/model', enabled: true, status: 'ready', serviceHello: { class_names: ['left_hand', 'right_hand', 'tongue', 'rest'] } as Record<string, unknown>, latestPrediction: null as null | { observation_id: string; received_at_ms: number }, lastError: '', sourceDetail: '等待 EEG' },
  acq: { streaming: false, device: 'omni' }, fresh: false,
  status: vi.fn(), ensure: vi.fn(), bridge: vi.fn(), enabled: vi.fn(), connect: vi.fn(), fetch: vi.fn(),
}))
vi.mock('../../acquisition/runtime', () => ({ acqRuntime: h.acq }))
vi.mock('../../lib/eeg/liveHub', () => ({ liveEegHub: { isFresh: () => h.fresh } }))
vi.mock('../../lib/model-runtime/modelRuntimeHub', () => ({
  modelUrlPresets: () => [{ id: 'proxy', url: 'ws://site/ws/model' }],
  modelRuntimeHub: { snapshot: h.snapshot, setUrl: (url: string) => { h.snapshot.url = url }, setEnabled: h.enabled, connect: h.connect },
}))
vi.mock('../../lib/model-runtime/modelServiceApi', () => ({ modelServiceStatus: h.status, ensureModelService: h.ensure }))
vi.mock('../smr-grid/ensureBcigoStream', () => ({ ensureGridBcigoStream: h.bridge }))
import { connectNeuroSlide, S04_HEAD } from './connection'
import { connectGroupedSmrModel } from '../../lib/model-runtime/connectSmrModel'
import { S04_MODEL_OPTIONS } from '../../lib/model-runtime/subjectModels'

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('fetch', h.fetch)
  Object.assign(h.snapshot, { url: 'ws://site/ws/model', enabled: true, status: 'ready', serviceHello: { class_names: ['left_hand', 'right_hand', 'tongue', 'rest'] }, latestPrediction: null, lastError: '' })
  Object.assign(h.acq, { streaming: false, device: 'omni' }); h.fresh = false
  h.status.mockResolvedValue({ ok: true, running: true })
  h.ensure.mockResolvedValue({ ok: true, running: true })
  h.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, id: null }) })
  h.bridge.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function connectWithoutPrediction(headId?: string) {
  const progress = vi.fn()
  await connectNeuroSlide(new AbortController().signal, progress, headId)
  expect(progress).toHaveBeenLastCalledWith('模型与 EEG 来源已接入')
  expect(h.snapshot.latestPrediction).toBeNull()
}

it('attaches EEG in a fresh tab without waiting for a prediction', async () => {
  await connectWithoutPrediction()
  expect(h.bridge).toHaveBeenCalledOnce()
  expect(h.ensure).not.toHaveBeenCalled()
  expect(h.connect).not.toHaveBeenCalled()
})
it('reuses a fresh same-tab EEG source without reconnecting the device', async () => {
  h.acq.streaming = true; h.acq.device = 'neuracle'; h.fresh = true
  await connectWithoutPrediction()
  expect(h.bridge).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})
it.each(S04_MODEL_OPTIONS)('reuses the verified historical head $label when its filename is not exposed', async option => {
  h.status.mockResolvedValue({ ok: true, running: true, headId: null, modelRevision: null })
  h.snapshot.serviceHello.model_revision = option.revision
  h.acq.streaming = true; h.fresh = true
  h.ensure.mockRejectedValue(new Error('recording lock'))
  await connectWithoutPrediction(option.id)
  expect(h.ensure).not.toHaveBeenCalled()
  expect(h.bridge).not.toHaveBeenCalled()
})
it('does not treat an initial-head handshake as the selected S04 model', async () => {
  h.snapshot.serviceHello.model_revision = 'stieger2021_4class_reve_lora_r16_mi5init'
  h.ensure.mockRejectedValue(new Error('recording lock'))
  await expect(connectNeuroSlide(new AbortController().signal, vi.fn(), S04_HEAD)).rejects.toThrow('recording lock')
  expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ headId: S04_HEAD }))
})
it('does not attach BCIGo for a model that consumes SDK EEG directly', async () => {
  h.snapshot.serviceHello.input_source = 'omni-sdk'
  await connectWithoutPrediction(); expect(h.bridge).not.toHaveBeenCalled()
})
it('starts a model only when no service is running', async () => {
  h.status.mockResolvedValue({ ok: true, running: false })
  await connectWithoutPrediction()
  expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ backend: 'reve', task: 'smr_control' }))
})
it('loads an explicitly selected subject head instead of silently keeping the initial head', async () => {
  h.ensure.mockImplementation(async () => {
    h.snapshot.serviceHello.model_revision = 's04-revision'
    return { ok: true, running: true, headId: 's04.pt', modelRevision: 's04-revision' }
  })
  await connectWithoutPrediction('s04.pt')
  expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ headId: 's04.pt' }))
})
it('keeps the live model when its revision differs from the selected head', async () => {
  h.ensure.mockResolvedValue({ ok: true, running: true, headId: 's04.pt', modelRevision: 'expected-s04' })
  h.snapshot.serviceHello.model_revision = 'old-initial-head'
  h.acq.streaming = true; h.fresh = true
  await connectWithoutPrediction('s04.pt')
})
it('connects to the shared stream even while another tab is recording', async () => {
  h.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, id: 'recording' }) })
  await connectWithoutPrediction()
  expect(h.bridge).toHaveBeenCalledOnce()
})
it('connects a model even when its class names are not the four SMR labels', async () => {
  h.snapshot.serviceHello.class_names = ['a', 'b', 'c']
  h.acq.streaming = true; h.fresh = true
  await connectWithoutPrediction()
  expect(h.ensure).not.toHaveBeenCalled()
})
it.each(['eegnet', 'reve'])('reuses the applied %s model for grouped SMR', async backend => {
  h.status.mockResolvedValue({ ok: true, running: true, backend })
  h.snapshot.serviceHello.model_type = backend
  h.acq.streaming = true
  h.fresh = true
  const progress = vi.fn()
  await connectGroupedSmrModel(new AbortController().signal, progress)
  expect(progress).toHaveBeenLastCalledWith('已接入当前 4 类 SMR 模型与原始 EEG')
  expect(h.ensure).not.toHaveBeenCalled()
  expect(h.snapshot.latestPrediction).toBeNull()
})
it.each([['right_hand', 'left_hand'], ['tongue', 'rest']])('reuses a running binary model with labels %s and %s', async (a, b) => {
  h.snapshot.serviceHello.class_names = [a, b]
  h.acq.streaming = true; h.fresh = true
  const progress = vi.fn()
  await connectGroupedSmrModel(new AbortController().signal, progress)
  expect(progress).toHaveBeenLastCalledWith('已接入当前 2 类 SMR 模型与原始 EEG')
  expect(h.ensure).not.toHaveBeenCalled()
})
it('uses the selected external model socket for grouped SMR', async () => {
  h.snapshot.url = 'ws://other/v1/model'
  h.snapshot.serviceHello.class_names = ['left_hand', 'right_hand']
  h.acq.streaming = true; h.fresh = true
  await connectGroupedSmrModel(new AbortController().signal, vi.fn())
  expect(h.snapshot.url).toBe('ws://other/v1/model')
  expect(h.status).not.toHaveBeenCalled()
  expect(h.ensure).not.toHaveBeenCalled()
})
it('starts the configured REVE head when the managed service is idle', async () => {
  h.status.mockResolvedValue({ ok: false, running: false })
  h.acq.streaming = true; h.fresh = true
  await connectGroupedSmrModel(new AbortController().signal, vi.fn())
  expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ backend: 'reve', task: 'smr_control' }))
})
it('reports labels for an incompatible model without replacing it', async () => {
  h.snapshot.serviceHello.class_names = ['left_hand', 'tongue']
  await expect(connectGroupedSmrModel(new AbortController().signal, vi.fn())).rejects.toThrow('left_hand / tongue')
  expect(h.ensure).not.toHaveBeenCalled()
})
it('cancels the handshake wait when leaving the page or switching input', async () => {
  h.snapshot.status = 'connecting'
  const controller = new AbortController()
  const result = expect(connectNeuroSlide(controller.signal, vi.fn())).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(100)
  controller.abort(); await result
  expect(vi.getTimerCount()).toBe(0)
})
