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

async function connectWithPrediction(headId?: string) {
  const progress = vi.fn((message: string) => {
    if (message.includes('首个新预测')) setTimeout(() => {
      h.snapshot.latestPrediction = { observation_id: 'new', received_at_ms: performance.now() }
    }, 200)
  })
  const result = connectNeuroSlide(new AbortController().signal, progress, headId)
  await vi.advanceTimersByTimeAsync(300)
  await result
  expect(progress).toHaveBeenLastCalledWith('已接入现有模型 · 正在接收 EEG 四分类预测')
}

it('attaches EEG in a fresh tab, and only reports success after receiving a new prediction', async () => {
  await connectWithPrediction()
  expect(h.bridge).toHaveBeenCalledOnce()
  expect(h.ensure).not.toHaveBeenCalled()
  expect(h.connect).not.toHaveBeenCalled()
})
it('reuses a fresh same-tab EEG source without reconnecting the device', async () => {
  h.acq.streaming = true; h.acq.device = 'neuracle'; h.fresh = true
  await connectWithPrediction()
  expect(h.bridge).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})
it.each(S04_MODEL_OPTIONS)('reuses the verified historical head $label when its filename is not exposed', async option => {
  h.status.mockResolvedValue({ ok: true, running: true, headId: null, modelRevision: null })
  h.snapshot.serviceHello.model_revision = option.revision
  h.acq.streaming = true; h.fresh = true
  h.ensure.mockRejectedValue(new Error('recording lock'))
  await connectWithPrediction(option.id)
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
  await connectWithPrediction(); expect(h.bridge).not.toHaveBeenCalled()
})
it('starts a model only when no service is running', async () => {
  h.status.mockResolvedValue({ ok: true, running: false })
  await connectWithPrediction()
  expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ backend: 'reve', task: 'smr_control' }))
})
it('loads an explicitly selected subject head instead of silently keeping the initial head', async () => {
  h.ensure.mockImplementation(async () => {
    h.snapshot.serviceHello.model_revision = 's04-revision'
    return { ok: true, running: true, headId: 's04.pt', modelRevision: 's04-revision' }
  })
  const result = connectNeuroSlide(new AbortController().signal, message => {
    if (message.includes('首个新预测')) setTimeout(() => { h.snapshot.latestPrediction = { observation_id: 's04', received_at_ms: performance.now() } }, 100)
  }, 's04.pt')
  await vi.advanceTimersByTimeAsync(300); await result
  expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ headId: 's04.pt' }))
})
it('rejects a stale model handshake after an attempted subject-head switch', async () => {
  h.ensure.mockResolvedValue({ ok: true, running: true, headId: 's04.pt', modelRevision: 'expected-s04' })
  h.snapshot.serviceHello.model_revision = 'old-initial-head'
  await expect(connectNeuroSlide(new AbortController().signal, vi.fn(), 's04.pt')).rejects.toThrow('实际模型版本')
})
it('does not take over a bridge while another tab is recording', async () => {
  h.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, id: 'recording' }) })
  await expect(connectNeuroSlide(new AbortController().signal, vi.fn())).rejects.toThrow('其他页面正在录制')
  expect(h.bridge).not.toHaveBeenCalled()
})
it('rejects a non-four-class model without changing its weights or device', async () => {
  h.snapshot.serviceHello.class_names = ['a', 'b', 'c']
  await expect(connectNeuroSlide(new AbortController().signal, vi.fn())).rejects.toThrow('不是四分类')
  expect(h.ensure).not.toHaveBeenCalled(); expect(h.bridge).not.toHaveBeenCalled()
})
it('reports missing predictions even when model and bridge handshakes succeeded', async () => {
  const result = expect(connectNeuroSlide(new AbortController().signal, vi.fn())).rejects.toThrow('未收到新预测')
  await vi.advanceTimersByTimeAsync(21000); await result
})
it('cancels readiness waits when leaving the page or switching input', async () => {
  const controller = new AbortController()
  const result = expect(connectNeuroSlide(controller.signal, vi.fn())).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(100)
  controller.abort(); await result
  expect(vi.getTimerCount()).toBe(0)
})
