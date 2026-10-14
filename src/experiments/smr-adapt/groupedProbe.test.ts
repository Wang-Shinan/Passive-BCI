import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  revision: 'old', status: 'ready', headId: 'old.pt',
  ensure: vi.fn(), stop: vi.fn(), progress: vi.fn(), statusApi: vi.fn(),
}))
vi.mock('../../lib/model-runtime/modelServiceApi', () => ({
  ensureModelService: mock.ensure, stopModelService: mock.stop, modelServiceStatus: mock.statusApi,
}))
vi.mock('../../lib/model-runtime/modelRuntimeHub', () => ({ modelRuntimeHub: {
  get snapshot() { return { status: mock.status, serviceHello: { strategy: 'none', model_revision: mock.revision,
    model_name: 'reve-base', class_names: ['left_hand', 'right_hand', 'tongue', 'rest'] } } },
  latestObservation: () => ({ model_revision: mock.revision, class_names: ['left_hand', 'right_hand', 'tongue', 'rest'],
    prepare_latency_ms: 1, inference_latency_ms: 10 }),
  disconnect: vi.fn(), setEnabled: vi.fn(), connect: vi.fn(),
} }))
import { runGroupProbe, runRoundLora, waitForProbePrediction, type ProbeRound, type ProbeReport } from './groupedProbe'

const options = { minimumGain: .02, maximumRecallDrop: 0 }
function round(): ProbeRound {
  return { id: 'round', subjectId: 'S01', seed: 3, sessions: ['group1'],
    baseline: { headId: 'old.pt', revision: 'old', modelName: 'reve-base', stepSec: .5 } }
}
function report(promote = true) {
  return { headId: 'new.pt', baselineHeadId: 'copy.pt', baselineRevision: 'old', modelRevision: 'new',
    validationSnapshot: 'fixed', baseline: { balancedAccuracy: .5 }, metrics: { validation: { balancedAccuracy: .75 } },
    decision: { promote, reason: promote ? '达标' : '未达标' } }
}
function server(result: Partial<ProbeReport> = report(), failed = false) {
  const requests: Array<{ url: string; body: Record<string, unknown> | undefined }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url, body })
    let data: unknown = { ok: true }
    if (url.endsWith('/jobs') && body) data = { ok: true, job: { id: body.kind } }
    if (url.endsWith('/jobs/export')) data = { ok: true, job: { status: 'complete' }, report: {} }
    if (url.endsWith('/jobs/fit') || url.endsWith('/jobs/lora')) data = { ok: true, job: { status: failed ? 'failed' : 'complete', error: 'GPU error' }, report: result }
    return new Response(JSON.stringify(data), { status: 200 })
  }))
  return requests
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.revision = 'old'; mock.headId = 'old.pt'; mock.status = 'ready'
  mock.statusApi.mockImplementation(async () => ({ running: true, owned: true, backend: 'reve', task: 'smr_control', headId: mock.headId, stepSec: .5 }))
  mock.stop.mockResolvedValue({ ok: true })
  mock.ensure.mockImplementation(async ({ headId }: { headId: string }) => {
    mock.headId = headId; mock.revision = headId === 'new.pt' ? 'new' : 'old'
    return { running: true }
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('group boundary probing', () => {
  const lora = { epochs: 5, lr: .0001, rank: 4, alpha: 8, batchSize: 1, accumulationSteps: 8 }
  it('trains round-end LoRA from the history export and records the selected model for the next round', async () => {
    const requests = server()
    const state = round()
    await runRoundLora(state, options, lora, new AbortController().signal, mock.progress)
    expect(requests.find(r => r.body?.kind === 'export')?.body).toMatchObject({ scope: 'history', roundId: 'round' })
    expect(requests.find(r => r.body?.kind === 'lora')?.body).toMatchObject({ ...lora, ...options, datasetId: 'export', baselineRevision: 'old' })
    expect(state.baseline.revision).toBe('new')
    expect(requests.at(-1)?.body).toMatchObject({ type: 'model_decision', data: { stage: 'lora', selected: { headId: 'new.pt' } } })
  })
  it('restores the previous model on LoRA failure or rejects a candidate that cannot reload', async () => {
    server(report(), true)
    const state = round()
    expect(await runRoundLora(state, options, lora, new AbortController().signal, mock.progress)).toContain('GPU error')
    expect(state.baseline.revision).toBe('old')
    server()
    mock.ensure.mockRejectedValueOnce(new Error('adapter missing'))
    expect(await runRoundLora(state, options, lora, new AbortController().signal, mock.progress)).toContain('adapter missing')
    expect(state.baseline.revision).toBe('old')
  })
  it('exports cumulative groups, trains, activates a passing candidate and journals the actual model', async () => {
    const requests = server()
    const state = round()
    await runGroupProbe(state, options, new AbortController().signal, mock.progress)
    expect(requests.find(r => r.body?.kind === 'export')?.body?.sessions).toEqual(['group1'])
    expect(requests.find(r => r.body?.kind === 'fit')?.body).toMatchObject({ datasetId: 'export', baselineRevision: 'old', ...options })
    expect(mock.stop).toHaveBeenCalledOnce()
    expect(mock.ensure).toHaveBeenCalledWith(expect.objectContaining({ headId: 'new.pt' }))
    expect(state.baseline.revision).toBe('new')
    expect(requests.at(-1)?.body).toMatchObject({ type: 'model_decision', data: { selected: { headId: 'new.pt' } } })
  })
  it('keeps the frozen baseline when the candidate fails evaluation', async () => {
    server(report(false))
    const state = round()
    await runGroupProbe(state, options, new AbortController().signal, mock.progress)
    expect(state.baseline).toMatchObject({ headId: 'copy.pt', revision: 'old' })
    expect(mock.ensure).not.toHaveBeenCalledWith(expect.objectContaining({ headId: 'new.pt' }))
  })
  it('restores the original model after a failed training process', async () => {
    server(report(), true)
    const state = round()
    const message = await runGroupProbe(state, options, new AbortController().signal, mock.progress)
    expect(message).toContain('GPU error')
    expect(state.baseline.headId).toBe('old.pt')
  })
  it('rolls back a failed candidate load; failed rollback remains blocked', async () => {
    server()
    mock.ensure.mockRejectedValueOnce(new Error('candidate load failed'))
    const state = round()
    await runGroupProbe(state, options, new AbortController().signal, mock.progress)
    expect(mock.ensure.mock.calls.map(args => args[0].headId)).toEqual(['new.pt', 'old.pt'])
    expect(state.baseline.revision).toBe('old')
    mock.ensure.mockRejectedValue(new Error('cannot restore'))
    await expect(runGroupProbe(round(), options, new AbortController().signal, mock.progress)).rejects.toThrow('cannot restore')
  })
  it('rejects a changed model before stopping or training', async () => {
    server()
    mock.revision = 'other'
    await expect(runGroupProbe(round(), options, new AbortController().signal, mock.progress)).rejects.toThrow('更换')
    expect(mock.stop).not.toHaveBeenCalled()
  })
  it('does not activate a late result after cancellation', async () => {
    server()
    const controller = new AbortController()
    mock.stop.mockImplementationOnce(async () => { controller.abort(); throw controller.signal.reason })
    await expect(runGroupProbe(round(), options, controller.signal, mock.progress)).rejects.toBeDefined()
    expect(mock.ensure).not.toHaveBeenCalled()
  })
  it('keeps the next group blocked when predictions still belong to the old model', async () => {
    vi.useFakeTimers()
    const pending = waitForProbePrediction({ ...round().baseline, revision: 'new' }, new AbortController().signal)
    const assertion = expect(pending).rejects.toThrow('45 秒')
    await vi.advanceTimersByTimeAsync(45001)
    await assertion
  })
  it('skips insufficient data and reloads the original without applying a candidate', async () => {
    server({ ...report(), skipped: true, reason: '样本不足' })
    const state = round()
    const message = await runGroupProbe(state, options, new AbortController().signal, mock.progress)
    expect(message).toContain('样本不足')
    expect(mock.ensure).toHaveBeenCalledWith(expect.objectContaining({ headId: 'old.pt' }))
  })
})
