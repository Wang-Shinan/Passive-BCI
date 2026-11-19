import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OmniGuiHttpClient, type GuiInterruption, type GuiStreamContext, type OmniGuiClientOptions } from './guiClient'
import type { OmniDataBatch, OmniHello } from './protocol'
import type { OmniStatus } from './client'

const NAMES = ['CH1', 'CH2']

const okStatus = {
  schema_version: 1, connected: true, streaming: true, api_control_enabled: true,
  sample_rate_hz: 250, frames: 500, sequence_lost: 0, session_id: 'sess1', status: 'streaming',
}

function frame(seq: number, vals: number[], extra?: Record<string, unknown>) {
  return { sequence: seq, values_uv: vals, valid: true, mode: 0, source_timestamp_us: 0, ...extra }
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

type RouteResult = { body?: unknown; status?: number; hang?: boolean } | Promise<Response>
type Route = RouteResult | (() => RouteResult)

function makeFetch(routes: Record<string, Route>) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const entry = routes[key!]
    const route = typeof entry === 'function' ? entry() : entry
    if (!route) return Promise.reject(new Error(`no route for ${url}`))
    if (route instanceof Promise) return route
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200))
  })
  return { fetchImpl, calls }
}

type Events = {
  statuses: [OmniStatus, string?][]
  hellos: OmniHello[]
  batches: OmniDataBatch[]
  errors: string[]
  fatals: string[]
  interrupts: GuiInterruption[]
  ready: GuiStreamContext[]
}

function harness(fetchImpl: OmniGuiClientOptions['fetchImpl'], opts: Partial<OmniGuiClientOptions> = {}) {
  const events: Events = { statuses: [], hellos: [], batches: [], errors: [], fatals: [], interrupts: [], ready: [] }
  const client = new OmniGuiHttpClient({
    basePath: '/api/omni-gui',
    fetchImpl,
    autoRecover: true,
    onStatus: (s, d) => events.statuses.push([s, d]),
    onHello: (h) => events.hellos.push(h),
    onBatch: (b) => events.batches.push(b),
    onError: (m) => events.errors.push(m),
    onFatal: (m) => events.fatals.push(m),
    onInterrupt: (e) => { events.interrupts.push(e) },
    onReady: (c) => { events.ready.push(c) },
    ...opts,
  })
  return { client, events }
}

describe('OmniGuiHttpClient autoRecover', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('recovers a 409: one interruption, fresh tail re-subscribe, no old data replay', async () => {
    let conflictActive = true
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => conflictActive
        ? { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) }
        : { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) },
      'generation=7&cursor=100': () => conflictActive
        ? { status: 409, body: conflict(8, 0, 500) }
        : { body: dataPage(7, 100, 100, 100, []) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 502, 502, [frame(61, [3, 4]), frame(62, [5, 6])]) },
      'generation=8&cursor=502': { body: dataPage(8, 502, 502, 502, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    expect(events.hellos).toHaveLength(1)
    expect(events.ready).toHaveLength(1)
    expect(events.ready[0]!.generation).toBe(7)
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(1)
    expect(events.interrupts[0]!.reason).toBe('conflict')
    expect(events.interrupts[0]!.context?.generation).toBe(7)
    conflictActive = false
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    expect(events.ready[1]!.generation).toBe(8)
    expect(events.ready[1]!.segmentId).toBe(1)
    expect(events.ready[1]!.reset?.fromCursor).toBe(100)
    expect(events.ready[1]!.reset?.toCursor).toBe(500)
    const seqs = events.batches.flatMap((b) => Array.from(b.sequence))
    expect(seqs).toEqual([61, 62])
    expect(events.batches[0]?.sessionId).toBe('gui-sess1:8')
    expect(events.errors).toHaveLength(0)
    expect(events.fatals).toHaveLength(0)
    client.disconnect()
  })

  it('a 409 with malformed bounds is fatal, not recoverable', async () => {
    for (const bad of [null, {}, { error: 'x' }, { bounds: {} },
      { bounds: { generation: 8, oldest_cursor: 5, end_cursor: 2 } }]) {
      const { fetchImpl } = makeFetch({
        '/v1/status': { body: okStatus },
        '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
        'generation=7&cursor=100': { status: 409, body: bad },
      })
      const { client, events } = harness(fetchImpl)
      client.connect()
      await vi.advanceTimersByTimeAsync(60)
      expect(events.fatals.length).toBeGreaterThan(0)
      expect(events.interrupts).toHaveLength(0)
      client.disconnect()
    }
  })

  it('recovers a transport failure without duplicate interrupts or parallel requests', async () => {
    let down = true
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => down
        ? { hang: true }
        : { body: dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(7, [3, 4])]) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(2600)
    expect(events.interrupts).toHaveLength(1)
    expect(events.interrupts[0]!.reason).toBe('transport')
    down = false
    const callsBefore = calls.length
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    expect(events.interrupts).toHaveLength(1)
    const seqs = events.batches.flatMap((b) => Array.from(b.sequence))
    expect(seqs).toEqual([6, 7])
    expect(calls.length).toBeGreaterThan(callsBefore)
    client.disconnect()
  })

  it('a gapped page is not delivered and instead resets the stream', async () => {
    let gap = true
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => gap
        ? { body: dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(9, [3, 4])]) }
        : { body: dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(7, [3, 4])]) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(1)
    expect(events.interrupts[0]!.reason).toBe('sequence_gap')
    expect(events.batches).toHaveLength(0)
    gap = false
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    const seqs = events.batches.flatMap((b) => Array.from(b.sequence))
    expect(seqs).toEqual([6, 7])
    client.disconnect()
  })

  it('duplicate or reversed sequence is a discontinuity, and invalid frames quarantine', async () => {
    for (const [frames, reason] of [
      [[frame(6, [1, 2]), frame(6, [3, 4])], 'sequence_gap'],
      [[frame(6, [1, 2]), frame(5, [3, 4])], 'sequence_gap'],
      [[frame(6, [1, 2]), { ...frame(7, [3, 4]), valid: false }], 'invalid_frame'],
    ] as const) {
      const { fetchImpl } = makeFetch({
        '/v1/status': { body: okStatus },
        '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
        'generation=7&cursor=100': { body: dataPage(7, 100, 102, 102, [...frames]) },
      })
      const { client, events } = harness(fetchImpl)
      client.connect()
      await vi.advanceTimersByTimeAsync(60)
      expect(events.interrupts).toHaveLength(1)
      expect(events.interrupts[0]!.reason).toBe(reason)
      expect(events.batches).toHaveLength(0)
      client.disconnect()
    }
  })

  it('u32 wrap-around sequence is contiguous and does not reset', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(0xfffffffe, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 102, 102, [frame(0xffffffff, [3, 4]), frame(0, [5, 6])]) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(0)
    expect(events.batches).toHaveLength(1)
    expect(Array.from(events.batches[0]!.sequence)).toEqual([0xffffffff, 0])
    client.disconnect()
  })

  it('holds the validated tail and polls it until fresh rows arrive', async () => {
    let polls = 0
    let tails = 0
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => {
        tails += 1
        return tails === 1
          ? { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) }
          : { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) }
      },
      'generation=7&cursor=100': { status: 409, body: conflict(8, 0, 500) },
      'generation=8&cursor=500': () => {
        polls += 1
        return polls < 3
          ? { body: dataPage(8, 500, 500, 500, []) }
          : { body: dataPage(8, 500, 502, 502, [frame(61, [3, 4]), frame(62, [5, 6])]) }
      },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2100)
    expect(events.ready).toHaveLength(1)
    expect(polls).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    expect(tails).toBe(2)
    const seqs = events.batches.flatMap((b) => Array.from(b.sequence))
    expect(seqs).toEqual([61, 62])
    client.disconnect()
  })

  it('a stale in-flight response cannot deliver or mutate after recovery begins', async () => {
    let release: (() => void) | null = null
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => release
        ? { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) }
        : { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse(dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(7, [3, 4])])))
      }),
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': { body: dataPage(8, 501, 501, 501, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(0)
    const staleResolve = release!
    client.requestRecovery('source_idle')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.interrupts).toHaveLength(1)
    staleResolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.batches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    const seqs = events.batches.flatMap((b) => Array.from(b.sequence))
    expect(seqs).toEqual([61])
    client.disconnect()
  })

  it('reconnecting the same object after a mid-recovery disconnect works', async () => {
    let healthy = false
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': () => healthy
        ? { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) }
        : { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { status: 409, body: conflict(8, 0, 500) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': { body: dataPage(8, 501, 501, 501, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(1)
    client.disconnect()
    healthy = true
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.hellos).toHaveLength(2)
    expect(events.statuses.filter(([st]) => st === 'live')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(events.batches.length).toBeGreaterThanOrEqual(1)
    client.disconnect()
  })

  it('initial connect requires a genuinely streaming, recorded upstream', async () => {
    for (const status of [
      { ...okStatus, streaming: false },
      { ...okStatus, connected: false },
      { ...okStatus, session_id: '' },
      { ...okStatus, stale: true },
    ]) {
      const { fetchImpl } = makeFetch({
        '/v1/status': { body: status },
        '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      })
      const { client, events } = harness(fetchImpl)
      client.connect()
      await vi.advanceTimersByTimeAsync(30)
      expect(events.fatals.length).toBeGreaterThan(0)
      expect(events.hellos).toHaveLength(0)
      client.disconnect()
    }
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 0, 0, 0, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(30)
    expect(events.fatals.length).toBeGreaterThan(0)
    client.disconnect()
  })

  it('changed channel layout is fatal and does not recover', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': {
        body: {
          ...dataPage(7, 100, 101, 101, [frame(6, [1, 2, 3])]),
          channel_names: ['CH1', 'CH2', 'CH3'],
        },
      },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.statuses.at(-1)?.[0]).toBe('error')
    expect(events.interrupts).toHaveLength(0)
    expect(events.ready).toHaveLength(1)
    client.disconnect()
  })

  it('disconnect during recovery cancels timers and future data', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { status: 409, body: conflict(8, 0, 500) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(9, [1, 2])]) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(60)
    expect(events.interrupts).toHaveLength(1)
    client.disconnect()
    const n = calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(events.ready).toHaveLength(1)
    expect(events.batches).toHaveLength(0)
    expect(calls.length).toBe(n)
  })

  it('empty-data stall triggers a recoverable outage', async () => {
    let live = false
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => live
        ? { body: dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(7, [3, 4])]) }
        : { body: dataPage(7, 100, 100, 100, []) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    await vi.advanceTimersByTimeAsync(2200)
    expect(events.interrupts).toHaveLength(1)
    expect(events.interrupts[0]!.reason).toBe('stalled')
    live = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    expect(events.batches).toHaveLength(1)
    client.disconnect()
  })

  it('requestRecovery from a page idle guard routes through the same reset', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 102, 102, [frame(6, [1, 2]), frame(7, [3, 4])]) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    client.requestRecovery('source_idle')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.interrupts).toHaveLength(1)
    expect(events.interrupts[0]!.reason).toBe('source_idle')
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.ready).toHaveLength(2)
    client.disconnect()
  })

  it('an api-control-disabled status during healthy polling is fatal', async () => {
    let apiOn = true
    const { fetchImpl } = makeFetch({
      '/v1/status': () => ({ body: apiOn ? okStatus : { ...okStatus, api_control_enabled: false } }),
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 101, 101, [frame(6, [1, 2])]) },
      'generation=7&cursor=101': { body: dataPage(7, 101, 101, 101, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    apiOn = false
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.fatals.length).toBe(1)
    expect(events.interrupts).toHaveLength(0)
    client.disconnect()
  })

  it('a status 404 during healthy polling is fatal', async () => {
    let gone = false
    const { fetchImpl } = makeFetch({
      '/v1/status': () => gone ? { status: 404, body: {} } : { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 101, 101, [frame(6, [1, 2])]) },
      'generation=7&cursor=101': { body: dataPage(7, 101, 101, 101, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    gone = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.fatals.length).toBe(1)
    client.disconnect()
  })

  it('a stale status snapshot triggers a recoverable outage, not a fatal', async () => {
    let stale = false
    const { fetchImpl } = makeFetch({
      '/v1/status': () => ({ body: stale ? { ...okStatus, snapshot_age_ms: 5000 } : okStatus }),
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 101, 101, [frame(6, [1, 2])]) },
      'generation=7&cursor=101': { body: dataPage(7, 101, 101, 101, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    stale = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.interrupts).toHaveLength(1)
    expect(events.interrupts[0]!.reason).toBe('status_stale')
    expect(events.fatals).toHaveLength(0)
    client.disconnect()
  })

  it('an old in-flight status rejection after recovery ready cannot start a new outage', async () => {
    let statusCalls = 0
    let releaseStatus: ((e: unknown) => void) | null = null
    let conflicted = false
    const { fetchImpl } = makeFetch({
      '/v1/status': () => {
        statusCalls += 1
        if (statusCalls === 2) {
          return new Promise<Response>((_resolve, reject) => { releaseStatus = reject })
        }
        return { body: okStatus }
      },
      '/v1/data?limit=1': () => conflicted
        ? { body: dataPage(8, 499, 500, 500, [frame(60, [9, 9])]) }
        : { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': () => conflicted
        ? { status: 409, body: conflict(8, 0, 500) }
        : { body: dataPage(7, 100, 101, 101, [frame(6, [1, 2])]) },
      'generation=7&cursor=101': () => conflicted
        ? { status: 409, body: conflict(8, 0, 500) }
        : { body: dataPage(7, 101, 101, 101, []) },
      'generation=8&cursor=500': { body: dataPage(8, 500, 501, 501, [frame(61, [3, 4])]) },
      'generation=8&cursor=501': { body: dataPage(8, 501, 501, 501, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    for (let i = 0; i < 60 && !releaseStatus; i++) await vi.advanceTimersByTimeAsync(30)
    expect(releaseStatus).not.toBeNull()
    conflicted = true
    for (let i = 0; i < 200 && events.ready.length < 2; i++) await vi.advanceTimersByTimeAsync(50)
    expect(events.ready.length).toBe(2)
    expect(events.interrupts).toHaveLength(1)
    releaseStatus!(new Error('socket reset'))
    await vi.advanceTimersByTimeAsync(800)
    expect(events.interrupts).toHaveLength(1)
    expect(events.fatals).toHaveLength(0)
    client.disconnect()
  })

  it('a transient status 500 triggers recovery, not a terminal stop', async () => {
    let failing = false
    const { fetchImpl } = makeFetch({
      '/v1/status': () => failing ? { status: 500, body: {} } : { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 101, 101, [frame(6, [1, 2])]) },
      'generation=7&cursor=101': { body: dataPage(7, 101, 101, 101, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(5)
    failing = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.interrupts).toHaveLength(1)
    expect(events.fatals).toHaveLength(0)
    client.disconnect()
  })
})
