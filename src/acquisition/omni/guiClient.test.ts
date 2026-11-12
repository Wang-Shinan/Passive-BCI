import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OmniGuiHttpClient, type OmniGuiClientOptions } from './guiClient'
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

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response
}

type Route = { body?: unknown; status?: number; hang?: boolean }

function makeFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const entry = routes[key!]
    const route: Route | undefined = typeof entry === 'function' ? (entry as () => Route)() : entry
    if (!route) return Promise.reject(new Error(`no route for ${url}`))
    if (route.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200))
  })
  return { fetchImpl, calls }
}

function harness(fetchImpl: OmniGuiClientOptions['fetchImpl']) {
  const events: { statuses: [OmniStatus, string?][]; hellos: OmniHello[]; batches: OmniDataBatch[]; errors: string[]; gui: unknown[] } = {
    statuses: [], hellos: [], batches: [], errors: [], gui: [],
  }
  const client = new OmniGuiHttpClient({
    basePath: '/api/omni-gui',
    fetchImpl,
    onStatus: (s, d) => events.statuses.push([s, d]),
    onHello: (h) => events.hellos.push(h),
    onBatch: (b) => events.batches.push(b),
    onError: (m) => events.errors.push(m),
    onGuiStatus: (s) => events.gui.push(s),
  })
  return { client, events }
}

describe('OmniGuiHttpClient', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fails visibly with diagnostics when api-control is off and never polls data', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: { ...okStatus, api_control_enabled: false, session_id: 's0' } },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.gui).toHaveLength(1)
    expect(events.errors.some((m) => m.includes('api-control'))).toBe(true)
    expect(events.statuses.at(-1)?.[0]).toBe('error')
    expect(events.hellos).toHaveLength(0)
    // no data request, no endless status polling
    expect(calls.filter((c) => c.url.includes('/v1/data'))).toHaveLength(0)
    const n = calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.length).toBe(n)
  })

  it('bootstraps at the end cursor, skips history, then streams ordered pages', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { body: dataPage(7, 100, 102, 102, [frame(6, [3, 4]), frame(7, [5, 6])]) },
      'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.hellos).toHaveLength(1)
    expect(events.hellos[0]?.channels).toEqual(NAMES)
    expect(events.hellos[0]?.sample_rate).toBe(250)
    expect(events.hellos[0]?.session_id).toBe('sess1')
    // bootstrap's historical row (seq 5) is not emitted; only the live page is
    await vi.advanceTimersByTimeAsync(1)
    expect(events.batches).toHaveLength(1)
    expect(Array.from(events.batches[0]!.sequence)).not.toContain(5)
    expect(events.batches[0]?.samples).toBe(2)
    expect(Array.from(events.batches[0]!.sequence)).toEqual([6, 7])
    expect(events.batches[0]?.sessionId).toBe('gui-sess1:7')
    expect(events.batches[0]?.packetCount).toBe(1)
    // empty page → no emission, cursor kept, 50ms cadence
    await vi.advanceTimersByTimeAsync(49)
    expect(events.batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(events.batches).toHaveLength(1)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('counts client-observed sequence gaps across pages and uint32 wrap', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(3, 99, 100, 100, [frame(0xfffffffe, [1, 2])]) },
      'generation=3&cursor=100': { body: dataPage(3, 100, 102, 102, [frame(0xffffffff, [3, 4]), frame(0, [5, 6])]) },
      'generation=3&cursor=102': { body: dataPage(3, 102, 103, 103, [frame(3, [7, 8])]) },
      'generation=3&cursor=103': { body: dataPage(3, 103, 103, 103, []) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(1) // bootstrap
    await vi.advanceTimersByTimeAsync(1) // cursor 100 → wrap seqs, delta 1+1 → 0 missing
    expect(events.batches[0]?.packetLoss).toBe(0)
    await vi.advanceTimersByTimeAsync(51) // idle cadence → cursor 102 → seq 3 after 0 → delta 3 → 2 missing
    expect(events.batches[1]?.packetLoss).toBe(2)
    expect(events.batches[1]?.packetCount).toBe(2)
  })

  it('stops with a visible error on 409 and on malformed next_cursor', async () => {
    for (const route of [
      { status: 409 },
      { body: dataPage(7, 100, 105, 105, [frame(6, [1, 2])]) },
    ]) {
      const { fetchImpl } = makeFetch({
        '/v1/status': { body: okStatus },
        '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
        'generation=7&cursor=100': route as Route,
        'generation=7&cursor=102': { body: dataPage(7, 102, 102, 102, []) },
      })
      const { client, events } = harness(fetchImpl)
      client.connect()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(events.statuses.at(-1)?.[0]).toBe('error')
      expect(events.errors.length).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(1000)
      // halted — no further data polling
      expect(events.batches.filter((b) => b.samples > 0)).toHaveLength(0)
      client.disconnect()
    }
  })

  it('suppresses late callbacks after disconnect', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { hang: true },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.hellos).toHaveLength(1)
    client.disconnect()
    await vi.advanceTimersByTimeAsync(10000)
    const statusesAfter = events.statuses.at(-1)?.[0]
    expect(statusesAfter).not.toBe('error')
    expect(events.batches).toHaveLength(0)
    const n = calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.length).toBe(n)
  })

  it('surfaces a hung fetch timeout as an error instead of stalling silently', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
      'generation=7&cursor=100': { hang: true },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(events.errors.some((m) => m.includes('数据拉取失败'))).toBe(true)
    expect(events.statuses.at(-1)?.[0]).toBe('error')
  })

  it('requires a schema-1 status payload', async () => {
    for (const body of [
      { ...okStatus, schema_version: undefined },
      { ...okStatus, schema_version: 2 },
    ]) {
      const { fetchImpl } = makeFetch({ '/v1/status': { body } })
      const { client, events } = harness(fetchImpl)
      client.connect()
      await vi.advanceTimersByTimeAsync(0)
      expect(events.hellos).toHaveLength(0)
      expect(events.errors.length).toBeGreaterThan(0)
      client.disconnect()
    }
  })

  it('rejects a bootstrap tail whose next_cursor is not end_cursor', async () => {
    const { fetchImpl } = makeFetch({
      '/v1/status': { body: okStatus },
      // valid cursor bounds, but next_cursor (99) ≠ end_cursor (100) → tail guard
      '/v1/data?limit=1': { body: dataPage(7, 0, 100, 99, [frame(5, [1, 2])]) },
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.hellos).toHaveLength(0)
    expect(events.errors.some((m) => m.includes('尾页游标'))).toBe(true)
    expect(events.statuses.at(-1)?.[0]).toBe('error')
  })

  it('aborts a hung post-hello status poll and a hung data request together on disconnect', async () => {
    const aborted: string[] = []
    let statusCalls = 0
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => aborted.push(url))
      if (url.includes('/v1/status')) {
        statusCalls += 1
        // first (connect-time) status resolves; post-hello poll hangs
        if (statusCalls === 1) return Promise.resolve(jsonResponse(okStatus))
        return new Promise<Response>(() => {})
      }
      if (url.includes('/v1/data?limit=1')) return Promise.resolve(jsonResponse(dataPage(7, 99, 100, 100, [frame(5, [1, 2])])))
      return new Promise<Response>(() => {}) // data poll hangs
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.hellos).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10) // post-hello status + data both in flight
    expect(statusCalls).toBe(2)
    client.disconnect()
    expect(aborted.filter((u) => u.includes('/v1/status'))).toHaveLength(1)
    expect(aborted.filter((u) => u.includes('/v1/data'))).toHaveLength(1)
  })

  it('does not overlap a slow status poll and schedules the next one 1s after completion', async () => {
    let statusCalls = 0
    let releaseSlow: (() => void) | null = null
    const statusUrls: string[] = []
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('/v1/status')) {
        statusUrls.push(url)
        statusCalls += 1
        if (statusCalls === 2) {
          // post-hello poll stays pending until released
          return new Promise<Response>((resolve) => { releaseSlow = () => resolve(jsonResponse(okStatus)) })
        }
        return Promise.resolve(jsonResponse(okStatus))
      }
      if (url.includes('/v1/data?limit=1')) return Promise.resolve(jsonResponse(dataPage(7, 99, 100, 100, [frame(5, [1, 2])])))
      return Promise.resolve(jsonResponse(dataPage(7, 100, 100, 100, [])))
    })
    const { client, events } = harness(fetchImpl)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.hellos).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10) // post-hello status now pending, data empty-polling
    expect(statusCalls).toBe(2)
    // >2s pass while the status request is still pending — no overlap issued
    await vi.advanceTimersByTimeAsync(2500)
    expect(statusCalls).toBe(2)
    releaseSlow!()
    await vi.advanceTimersByTimeAsync(0) // completion
    expect(statusCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(statusCalls).toBe(2) // next poll due 1s AFTER completion, not on interval
    await vi.advanceTimersByTimeAsync(1)
    expect(statusCalls).toBe(3)
    client.disconnect()
  })

  it('emits no live status and no timers when onHello disconnects', async () => {
    const { fetchImpl, calls } = makeFetch({
      '/v1/status': { body: okStatus },
      '/v1/data?limit=1': { body: dataPage(7, 99, 100, 100, [frame(5, [1, 2])]) },
    })
    const events = { statuses: [] as [OmniStatus, string?][], errors: [] as string[] }
    const client = new OmniGuiHttpClient({
      basePath: '/api/omni-gui',
      fetchImpl,
      onStatus: (s, d) => events.statuses.push([s, d]),
      onHello: () => client.disconnect(),
      onError: (m) => events.errors.push(m),
    })
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.statuses.some(([s]) => s === 'live')).toBe(false)
    const n = calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.length).toBe(n)
    expect(events.errors).toHaveLength(0)
  })
})
