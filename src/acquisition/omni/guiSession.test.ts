import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OmniGuiSession,
  requestGuiRecovery,
  subscribeGuiContinuity,
  suppressGuiSegmentReopen,
  type GuiContinuityEvent,
} from './guiSession'
import { guiTriggerQueue } from './guiTrigger'
import { acqRuntime } from '../runtime'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { sampleClock } from '../../lib/eeg/sampleClock'
import { sessionHub } from '../../lib/session/sessionHub'
import type { OmniDataBatch } from './protocol'

const NAMES = ['CH1', 'CH2']

const okStatus = {
  schema_version: 1, connected: true, streaming: true, api_control_enabled: true,
  sample_rate_hz: 250, session_id: 'sess1', status: 'streaming',
}

function frame(seq: number, vals: number[]) {
  return { sequence: seq, values_uv: vals, valid: true, mode: 0 }
}

function dataPage(gen: number, oldest: number, end: number, next: number, frames: unknown[]) {
  return {
    generation: gen, oldest_cursor: oldest, end_cursor: end, next_cursor: next,
    sample_rate_hz: 250, channel_names: [...NAMES], frames,
    source: 'original_device_frames',
  }
}

function conflict(generation: number, oldest: number, end: number) {
  return { error: 'cursor_out_of_range', bounds: { generation, oldest_cursor: oldest, end_cursor: end } }
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response
}

function makeFetch(routes: Record<string, { body?: unknown; status?: number } | (() => { body?: unknown; status?: number })>) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const entry = routes[key!]
    const route = typeof entry === 'function' ? entry() : entry
    if (!route) return Promise.reject(new Error(`no route for ${url}`))
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200))
  })
  return { fetchImpl, calls }
}

describe('OmniGuiSession', () => {
  const saved = {
    streaming: false as boolean,
    status: acqRuntime.status,
    device: acqRuntime.device,
    omniLink: acqRuntime.omniLink,
    omni: acqRuntime.omni,
  }
  let continuity: GuiContinuityEvent[] = []
  let unsub: (() => void) | null = null
  let batches: OmniDataBatch[] = []
  let errors: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    saved.streaming = acqRuntime.streaming
    saved.status = acqRuntime.status
    saved.device = acqRuntime.device
    saved.omniLink = acqRuntime.omniLink
    saved.omni = acqRuntime.omni
    acqRuntime.streaming = true
    acqRuntime.status = 'streaming'
    acqRuntime.device = 'omni'
    acqRuntime.omniLink = 'gui'
    liveEegHub.configure({ device: 'omni', sampleRate: 250, channelNames: [...NAMES] })
    liveEegHub.markStreaming()
    continuity = []
    batches = []
    errors = []
    unsub = subscribeGuiContinuity((e) => { continuity.push(e) })
  })

  afterEach(() => {
    unsub?.()
    unsub = null
    guiTriggerQueue.setContextProvider(null)
    acqRuntime.streaming = saved.streaming
    acqRuntime.status = saved.status
    acqRuntime.device = saved.device
    acqRuntime.omniLink = saved.omniLink
    acqRuntime.omni = saved.omni
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function session(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    return new OmniGuiSession({
      basePath: '/api/omni-gui',
      fetchImpl,
      onBatch: (b) => batches.push(b),
      onError: (m) => errors.push(m),
    })
  }

  it('saves the interrupted segment, reopens a linked one and resumes delivery', async () => {
    const startSpy = vi.spyOn(acqRuntime.recorder, 'start').mockResolvedValue('disk')
    const stopSpy = vi.spyOn(acqRuntime.recorder, 'stop').mockResolvedValue({
      bytes: 128, name: 'seg_a.bin', sink: 'disk', rel: 'recordings/seg_a', interrupted: true,
    })
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get')
      .mockReturnValue({ filenamePrefix: 'omni_focus_S01', meta: { device: 'omni' } })
    sessionHub.attach({ id: 'local-1', rel: 'recordings/seg_a' })
    sessionHub.bindMeta({ experiment: 'focus', subjectId: 'S01', runId: 'run-1' })
    let phase: 'healthy' | 'conflict' | 'recovered' = 'healthy'
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => phase === 'recovered'
        ? { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) }
        : { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => phase === 'conflict'
        ? { status: 409, body: conflict(8, 0, 500) }
        : { body: dataPage(7, 100, 100, 100, []) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': { body: dataPage(8, 501, 501, 501, []) },
      '/v1/trigger': { body: { accepted: true, session_id: 'sess1', sequence: 61, sample_index: 100, code: 10, label: 'pbc1|focus|e|0|prepare', host_time: '2025-01-01T00:00:00.000Z' } },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as typeof fetch
    let marker
    try {
      marker = await guiTriggerQueue.enqueue(10, 'pbc1|focus|e|0|prepare')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(marker.outcome).toBe('acked')
    phase = 'conflict'
    await vi.advanceTimersByTimeAsync(60)
    expect(continuity.some((e) => e.type === 'interrupt')).toBe(true)
    phase = 'recovered'
    await vi.advanceTimersByTimeAsync(1100)
    expect(continuity.some((e) => e.type === 'ready')).toBe(true)
    expect(stopSpy).toHaveBeenCalledWith({ interrupted: true, interruptionReason: 'conflict' })
    expect(startSpy).toHaveBeenCalledTimes(1)
    const meta = startSpy.mock.calls[0]?.[0]?.meta as Record<string, unknown>
    const rec = meta.recovery as Record<string, unknown>
    expect(rec.previousSegmentId).toBe('local-1')
    expect(rec.previousSegmentRel).toBe('recordings/seg_a')
    expect(rec.guiGeneration).toBe(8)
    expect(meta.runId).toBe('run-1')
    expect(meta.interrupted).toBeUndefined()
    expect(batches).toHaveLength(1)
    expect(Array.from(batches[0]!.sequence)).toEqual([61])
    expect(acqRuntime.streaming).toBe(true)
    s.disconnect()
    startSpy.mockRestore(); stopSpy.mockRestore()
  })

  it('connected-but-not-recording reopen does not start a recording', async () => {
    const startSpy = vi.spyOn(acqRuntime.recorder, 'start').mockResolvedValue('disk')
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(false)
    let conflictActive = true
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => conflictActive
        ? { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) }
        : { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) },
      'generation=7&cursor=100': () => conflictActive
        ? { status: 409, body: conflict(8, 0, 500) }
        : { body: dataPage(7, 100, 100, 100, []) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': { body: dataPage(8, 501, 501, 501, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    conflictActive = true
    await vi.advanceTimersByTimeAsync(60)
    conflictActive = false
    await vi.advanceTimersByTimeAsync(1100)
    expect(continuity.some((e) => e.type === 'ready')).toBe(true)
    expect(startSpy).not.toHaveBeenCalled()
    s.disconnect()
    startSpy.mockRestore()
  })

  it('suppression is scoped to one outage epoch; the next outage reopens', async () => {
    const startSpy = vi.spyOn(acqRuntime.recorder, 'start').mockResolvedValue('disk')
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get').mockReturnValue({ filenamePrefix: 'x' })
    vi.spyOn(acqRuntime.recorder, 'stop').mockResolvedValue({ bytes: 8, name: 'x.bin', sink: 'disk', rel: 'r' })
    let gen = 7
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => ({ body: dataPage(gen, gen * 100 - 1, gen * 100, gen * 100, [frame(5, [1, 2])]) }),
      'generation=7&cursor=700': { status: 409, body: conflict(8, 0, 800) },
      'generation=8&cursor=800': { body: dataPage(8, 800, 801, 801, [frame(6, [3, 4])]) },
      'generation=8&cursor=801': { status: 409, body: conflict(9, 0, 900) },
      'generation=9&cursor=900': { body: dataPage(9, 900, 901, 901, [frame(7, [5, 6])]) },
      'generation=9&cursor=901': { body: dataPage(9, 901, 901, 901, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    gen = 8
    await vi.advanceTimersByTimeAsync(60)
    suppressGuiSegmentReopen()
    await vi.advanceTimersByTimeAsync(1100)
    expect(startSpy).not.toHaveBeenCalled()
    expect(continuity.some((e) => e.type === 'ready')).toBe(true)
    gen = 9
    await vi.advanceTimersByTimeAsync(60)
    await vi.advanceTimersByTimeAsync(1200)
    expect(startSpy).toHaveBeenCalledTimes(1)
    s.disconnect()
    startSpy.mockRestore()
  })

  it('a failed interrupted save stops visibly and never reopens', async () => {
    const startSpy = vi.spyOn(acqRuntime.recorder, 'start').mockResolvedValue('disk')
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get').mockReturnValue({ filenamePrefix: 'x' })
    vi.spyOn(acqRuntime.recorder, 'stop').mockResolvedValue({ bytes: 8, name: 'x.bin', sink: 'disk', error: 'finish 500' })
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { status: 409, body: conflict(8, 0, 500) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(120)
    expect(errors.some((m) => m.includes('中断片段保存失败'))).toBe(true)
    expect(continuity.some((e) => e.type === 'stopped')).toBe(true)
    expect(startSpy).not.toHaveBeenCalled()
    s.disconnect()
    startSpy.mockRestore()
  })

  it('a fatal page error quarantines, saves once, clears the provider and stops', async () => {
    const stopSpy = vi.spyOn(acqRuntime.recorder, 'stop').mockResolvedValue({
      bytes: 64, name: 'x.bin', sink: 'disk', rel: 'r', interrupted: true,
    })
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get').mockReturnValue({ filenamePrefix: 'x' })
    sessionHub.attach({ id: 'local-1', rel: 'recordings/x' })
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 101, 101, [{ bogus: true }]) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(120)
    expect(continuity.some((e) => e.type === 'stopped')).toBe(true)
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(acqRuntime.streaming).toBe(false)
    const result = await guiTriggerQueue.enqueue(10, 't')
    expect(result.outcome).toBe('cancelled')
    s.disconnect()
    stopSpy.mockRestore()
  })

  it('a stale wrapper disconnect does not clear a newer session provider', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 101, 101, [frame(6, [3, 4])]) },
      'generation=7&cursor=101': { body: dataPage(7, 101, 101, 101, []) },
    })
    const first = session(fetchImpl)
    const second = session(fetchImpl)
    first.connect()
    second.connect()
    await vi.advanceTimersByTimeAsync(5)
    acqRuntime.omni = second
    sessionHub.attach({ id: 'local-2', rel: 'recordings/y' })
    first.disconnect()
    expect(requestGuiRecovery('source_idle')).toBe(true)
    second.disconnect()
    expect(requestGuiRecovery('source_idle')).toBe(false)
  })

  it('requestGuiRecovery routes through the active session only', async () => {
    expect(requestGuiRecovery('source_idle')).toBe(false)
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(7, [3, 4])]) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    expect(requestGuiRecovery('source_idle')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(continuity.some((e) => e.type === 'interrupt' && e.reason === 'source_idle')).toBe(true)
    s.disconnect()
    expect(requestGuiRecovery('source_idle')).toBe(false)
  })

  it('clears the trigger context provider on disconnect', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 100, 100, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    await vi.advanceTimersByTimeAsync(5)
    sessionHub.attach({ id: 'local-1', rel: 'recordings/x' })
    s.disconnect()
    const result = await guiTriggerQueue.enqueue(10, 't')
    expect(result.outcome).toBe('cancelled')
  })

  it('a fatal error after a successful recovery saves the NEW active segment', async () => {
    const stopSpy = vi.spyOn(acqRuntime.recorder, 'stop').mockResolvedValue({
      bytes: 8, name: 'x.bin', sink: 'disk', rel: 'r', interrupted: true,
    })
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get').mockReturnValue({ filenamePrefix: 'x' })
    let seg = 0
    sessionHub.attach({ id: 'local-1', rel: 'recordings/a' })
    vi.spyOn(acqRuntime.recorder, 'start').mockImplementation(async () => {
      seg += 1
      sessionHub.attach({ id: `local-1-${seg}`, rel: `recordings/n${seg}` })
      return 'disk'
    })
    let phase: 'healthy' | 'conflict' | 'recovered' | 'fatal' = 'healthy'
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => phase === 'healthy' || phase === 'conflict'
        ? { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) }
        : { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) },
      'generation=7&cursor=100': () => phase === 'healthy'
        ? { body: dataPage(7, 100, 100, 100, []) }
        : { status: 409, body: conflict(8, 0, 500) },
      'generation=8&cursor=500': () => phase === 'fatal'
        ? { body: { bogus: true } }
        : { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': () => phase === 'fatal'
        ? { body: { bogus: true } }
        : { body: dataPage(8, 501, 501, 501, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    phase = 'conflict'
    await vi.advanceTimersByTimeAsync(60)
    phase = 'recovered'
    await vi.advanceTimersByTimeAsync(1100)
    expect(continuity.some((e) => e.type === 'ready')).toBe(true)
    expect(stopSpy).toHaveBeenCalledTimes(1)
    phase = 'fatal'
    await vi.advanceTimersByTimeAsync(120)
    expect(continuity.filter((e) => e.type === 'stopped')).toHaveLength(1)
    expect(stopSpy).toHaveBeenCalledTimes(2)
    s.disconnect()
    stopSpy.mockRestore()
  })

  it('disconnect saves its own segment and resolves only after the save completes', async () => {
    let releaseStop: ((v: { bytes: number; name: string; sink: 'disk'; rel: string; interrupted: boolean }) => void) | null = null
    const stopSpy = vi.spyOn(acqRuntime.recorder, 'stop').mockImplementation(
      () => new Promise((resolve) => { releaseStop = resolve }),
    )
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockReturnValue(true)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get').mockReturnValue({ filenamePrefix: 'x' })
    sessionHub.attach({ id: 'local-1', rel: 'recordings/x' })
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 100, 100, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    let resolved = false
    const done = s.disconnect().then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(false)
    expect(stopSpy).toHaveBeenCalledWith({ interrupted: true, interruptionReason: 'disconnect' })
    releaseStop!({ bytes: 8, name: 'x.bin', sink: 'disk', rel: 'r', interrupted: true })
    await done
    expect(continuity.some((e) => e.type === 'interrupt' && e.reason === 'disconnect')).toBe(true)
    expect(continuity.some((e) => e.type === 'stopped' && e.reason === 'disconnect')).toBe(true)
    stopSpy.mockRestore()
  })

  it('owned cancel during a deferred reopen start closes only the new segment and never resumes', async () => {
    let recOn = true
    const stopSpy = vi.spyOn(acqRuntime.recorder, 'stop').mockImplementation(async () => {
      recOn = false
      return { bytes: 8, name: 'x.bin', sink: 'disk', rel: 'r', interrupted: true }
    })
    vi.spyOn(acqRuntime.recorder, 'recording', 'get').mockImplementation(() => recOn)
    vi.spyOn(acqRuntime.recorder, 'restartOptions', 'get').mockReturnValue({ filenamePrefix: 'x' })
    sessionHub.attach({ id: 'local-1', rel: 'recordings/a' })
    let releaseStart: (() => void) | null = null
    vi.spyOn(acqRuntime.recorder, 'start').mockImplementation(
      () => new Promise<'disk'>((resolve) => {
        releaseStart = () => {
          recOn = true
          sessionHub.attach({ id: 'local-2', rel: 'recordings/b' })
          resolve('disk')
        }
      }),
    )
    let conflicted = false
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => conflicted
        ? { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) }
        : { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => conflicted
        ? { status: 409, body: conflict(8, 0, 500) }
        : { body: dataPage(7, 100, 100, 100, []) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': { body: dataPage(8, 501, 501, 501, []) },
    })
    const s = session(fetchImpl)
    s.connect()
    acqRuntime.omni = s
    await vi.advanceTimersByTimeAsync(5)
    conflicted = true
    for (let i = 0; i < 200 && !releaseStart; i++) await vi.advanceTimersByTimeAsync(20)
    expect(releaseStart).not.toBeNull()
    const cancelling = suppressGuiSegmentReopen() as unknown as Promise<void>
    let settled = false
    void Promise.resolve(cancelling).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    releaseStart!()
    await cancelling
    expect(stopSpy).toHaveBeenCalledTimes(2)
    expect(recOn).toBe(false)
    expect(continuity.filter((e) => e.type === 'ready')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(continuity.filter((e) => e.type === 'ready')).toHaveLength(1)
    s.disconnect()
    stopSpy.mockRestore()
  })

  it('clearBridgeContinuity drops queued batches and resets the hub ring', async () => {
    const { clearBridgeContinuity, ingestBridgeToHub } = await import('../runtime')
    liveEegHub.pushInterleaved(new Float32Array(32).fill(1), 16, 2)
    expect(liveEegHub.ring.filled).toBeGreaterThanOrEqual(16)
    sampleClock.noteBatch({ samples: 10, sampleRate: 250, arrivalNowMs: performance.now() })
    ingestBridgeToHub({
      values: new Float32Array(4).fill(1), samples: 2, channels: 2, sampleRate: 250,
      channelNames: NAMES, unit: 'uV', packetLoss: 0, packetCount: 1,
    })
    clearBridgeContinuity()
    expect(liveEegHub.ring.filled).toBe(0)
    expect(liveEegHub.isFresh()).toBe(false)
    expect(sampleClock.snapshot()).toBeNull()
  })
})
