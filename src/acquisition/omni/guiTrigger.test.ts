import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GuiTriggerQueue,
  guiTriggerLabel,
  mapLogEventTrigger,
  setGuiTriggerLedger,
  validateGuiTriggerAck,
  type GuiTriggerContext,
  type GuiTriggerLedgerRecord,
} from './guiTrigger'
import { SessionLogger } from '../../lib/logger'
import { sessionHub } from '../../lib/session/sessionHub'

const CTX: GuiTriggerContext = {
  localRecordingId: 'rec-1',
  upstreamSessionId: 'sess1',
  generation: 7,
  segmentId: 0,
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response
}

function ack(over: Record<string, unknown> = {}) {
  return {
    accepted: true, session_id: 'sess1', sequence: 42, sample_index: 1234,
    code: 10, label: 'pbc1|focus|ev1|0|prepare', host_time: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function makeQueue(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  let ctx: GuiTriggerContext | null = CTX
  const queue = new GuiTriggerQueue({ basePath: '/api/omni-gui', fetchImpl })
  queue.setContextProvider(() => ctx)
  return { queue, setCtx: (next: GuiTriggerContext | null) => { ctx = next } }
}

describe('mapLogEventTrigger', () => {
  it('maps only focus/jaw markers with the lead-assigned codes', () => {
    expect(mapLogEventTrigger('focus', 'session_start')).toMatchObject({ code: 10 })
    expect(mapLogEventTrigger('focus', 'session_end')).toMatchObject({ code: 11 })
    expect(mapLogEventTrigger('focus', 'session_abort')).toMatchObject({ code: 12 })
    expect(mapLogEventTrigger('focus', 'acquisition_interrupted')).toMatchObject({ code: 13 })
    expect(mapLogEventTrigger('focus', 'acquisition_resumed')).toMatchObject({ code: 14 })
    expect(mapLogEventTrigger('jaw-clench', 'session_start')).toMatchObject({ code: 10 })
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'prepare', trialIndex: 0 }))
      .toMatchObject({ code: 100, trialIndex: 0, phase: 'prepare' })
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'cue', trialIndex: 0 }))
      .toMatchObject({ code: 110 })
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'collect', instructedLabel: 'relax', trialIndex: 1 }))
      .toMatchObject({ code: 120 })
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'collect', instructedLabel: 'focus', trialIndex: 1 }))
      .toMatchObject({ code: 121 })
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'recovery', trialIndex: 1 }))
      .toMatchObject({ code: 130 })
    expect(mapLogEventTrigger('focus', 'focus_invalid', { trialIndex: 2 }))
      .toMatchObject({ code: 140 })
    expect(mapLogEventTrigger('jaw-clench', 'jaw_phase', { phase: 'collect', instructedLabel: 'clench', trialIndex: 0 }))
      .toMatchObject({ code: 221 })
    expect(mapLogEventTrigger('jaw-clench', 'jaw_phase', { phase: 'collect', instructedLabel: 'relax', trialIndex: 0 }))
      .toMatchObject({ code: 220 })
    expect(mapLogEventTrigger('jaw-clench', 'jaw_invalid', { trialIndex: 0 }))
      .toMatchObject({ code: 240 })
    expect(mapLogEventTrigger('focus', 'focus_trial', { trialIndex: 0 })).toBeNull()
    expect(mapLogEventTrigger('jaw-clench', 'jaw_trial', { trialIndex: 0 })).toBeNull()
    expect(mapLogEventTrigger('tetris', 'session_start')).toBeNull()
    expect(mapLogEventTrigger('focus', 'context')).toBeNull()
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'collect', instructedLabel: 'bogus' })).toBeNull()
    expect(mapLogEventTrigger('focus', 'constructor')).toBeNull()
    expect(mapLogEventTrigger('focus', 'toString')).toBeNull()
    expect(mapLogEventTrigger('focus', 'focus_phase', { phase: 'hasOwnProperty', trialIndex: 0 })).toBeNull()
  })

  it('builds a bounded ASCII label', () => {
    const label = guiTriggerLabel('focus', 'uuid-1', { code: 100, trialIndex: 3, phase: 'prepare' })
    expect(label).toBe('pbc1|focus|uuid-1|3|prepare')
    expect(label.length).toBeLessThanOrEqual(128)
    expect(guiTriggerLabel('focus', 'uuid-1', { code: 10, trialIndex: null, phase: null }))
      .toBe('pbc1|focus|uuid-1|-|-')
  })
})

describe('validateGuiTriggerAck', () => {
  const req = { code: 10, label: 'pbc1|focus|ev1|0|prepare', context: CTX }
  it('accepts a strict matching ack including u32 wrap boundaries', () => {
    expect(validateGuiTriggerAck(ack(), req).ok).toBe(true)
    expect(validateGuiTriggerAck(ack({ sequence: 0xffffffff, sample_index: 0 }), req).ok).toBe(true)
    expect(validateGuiTriggerAck(ack({ sample_index: Number.MAX_SAFE_INTEGER }), req).ok).toBe(true)
  })
  it('rejects mismatched or malformed acks as uncertain', () => {
    for (const body of [
      null, [], 'x', { ...ack(), accepted: false }, { ...ack(), session_id: 'other' },
      { ...ack(), session_id: '' }, { ...ack(), sequence: -1 }, { ...ack(), sequence: 0x100000000 },
      { ...ack(), sequence: 1.5 }, { ...ack(), sample_index: -1 }, { ...ack(), code: 11 },
      { ...ack(), label: 'other' }, { ...ack(), host_time: 5 }, { ...ack(), host_time: '' },
      { ...ack(), host_time: undefined }, { ...ack(), host_time: 'not-a-date' },
    ]) {
      expect(validateGuiTriggerAck(body, req).ok).toBe(false)
    }
    expect(validateGuiTriggerAck(ack({ label: undefined }), req).ok).toBe(true)
  })
})

describe('GuiTriggerQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setGuiTriggerLedger(null)
  })
  afterEach(() => {
    setGuiTriggerLedger(null)
    vi.useRealTimers()
  })

  it('POSTs {code,label} once to the trigger route and resolves acked on strict ack', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const { queue } = makeQueue(async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(ack())
    })
    const result = await queue.enqueue(10, 'pbc1|focus|ev1|0|prepare')
    expect(result.outcome).toBe('acked')
    expect(result.ack?.sequence).toBe(42)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/omni-gui/v1/trigger')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ code: 10, label: 'pbc1|focus|ev1|0|prepare' })
  })

  it('keeps FIFO order with a single request in flight', async () => {
    const order: string[] = []
    const resolvers: (() => void)[] = []
    const { queue } = makeQueue((_url, init) => {
      const parsed = JSON.parse(init!.body as string) as { code: number; label: string }
      return new Promise<Response>((resolve) => {
        resolvers.push(() => { order.push(parsed.label); resolve(jsonResponse(ack({ label: parsed.label, code: parsed.code }))) })
      })
    })
    const p1 = queue.enqueue(10, 'first')
    const p2 = queue.enqueue(11, 'second')
    const p3 = queue.enqueue(12, 'third')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvers).toHaveLength(1)
    resolvers[0]!(); await vi.advanceTimersByTimeAsync(0)
    expect(resolvers).toHaveLength(2)
    resolvers[1]!(); await vi.advanceTimersByTimeAsync(0)
    expect(resolvers).toHaveLength(3)
    resolvers[2]!()
    expect((await p1).outcome).toBe('acked')
    expect((await p2).outcome).toBe('acked')
    expect((await p3).outcome).toBe('acked')
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('never retries: exactly one POST on timeout, 500 and malformed success', async () => {
    let calls = 0
    const hanging = makeQueue(() => {
      calls += 1
      return new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error('aborted')), 3000)
      })
    })
    const q2calls: number[] = [0]
    const hanging2 = new GuiTriggerQueue({
      basePath: '/api/omni-gui',
      fetchImpl: (_url, init) => {
        q2calls[0] += 1
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    })
    hanging2.setContextProvider(() => CTX)
    void calls
    const timeout = hanging2.enqueue(10, 't')
    await vi.advanceTimersByTimeAsync(2500)
    expect((await timeout).outcome).toBe('uncertain')
    expect(q2calls[0]).toBe(1)

    for (const responder of [
      () => jsonResponse({ error: 'boom' }, 500),
      () => jsonResponse({ not: 'an ack' }),
      () => jsonResponse(ack({ session_id: 'wrong' })),
    ]) {
      let n = 0
      const { queue } = makeQueue(async () => { n += 1; return responder() })
      const r = await queue.enqueue(10, 't')
      expect(r.outcome).toBe('uncertain')
      expect(n).toBe(1)
    }
    void hanging
  })

  it('treats a 4xx rejection as failed, distinct from uncertain', async () => {
    const { queue } = makeQueue(async () => jsonResponse({ message: 'bad code' }, 400))
    const result = await queue.enqueue(999, 't')
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('400')
  })

  it('cancels overflow, expired and context-changed entries without POSTing', async () => {
    const posts: string[] = []
    let release: (() => void) | null = null
    const { queue, setCtx } = makeQueue((_url, init) => {
      const parsed = JSON.parse(init!.body as string) as { code: number; label: string }
      posts.push(parsed.label)
      return new Promise<Response>((resolve) => { release = () => resolve(jsonResponse(ack({ label: parsed.label, code: parsed.code }))) })
    })
    const ledger: GuiTriggerLedgerRecord[] = []
    setGuiTriggerLedger((rec) => ledger.push(rec))
    const held = queue.enqueue(10, 'held')
    const queued = [queue.enqueue(11, 'a'), queue.enqueue(12, 'b')]
    setCtx({ ...CTX, generation: 8 })
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(await held).toMatchObject({ outcome: 'uncertain', error: 'context_changed_after_dispatch' })
    for (const p of queued) expect((await p).outcome).toBe('cancelled')
    expect(posts).toEqual(['held'])
    expect(ledger.some((r) => r.kind === 'trigger_request' && r.label === 'held')).toBe(true)
    expect(ledger.some((r) => r.kind === 'trigger_error' && r.label === 'held' && r.outcome === 'uncertain')).toBe(true)
    for (const label of ['a', 'b']) {
      expect(ledger.some((r) => r.kind === 'trigger_error' && r.label === label && r.outcome === 'cancelled')).toBe(true)
      expect(ledger.some((r) => r.kind === 'trigger_request' && r.label === label)).toBe(false)
    }

    const resolvers: ((parsed: { code: number; label: string }) => void)[] = []
    const slow = new GuiTriggerQueue({
      fetchImpl: (_url, init) => {
        const parsed = JSON.parse(init!.body as string) as { code: number; label: string }
        return new Promise<Response>((resolve) => {
          resolvers.push(() => resolve(jsonResponse(ack({ label: parsed.label, code: parsed.code }))))
        })
      },
    })
    slow.setContextProvider(() => CTX)
    void slow.enqueue(1, 'inflight')
    const overflow = Array.from({ length: 40 }, (_, i) => slow.enqueue(2, `q${i}`))
    const results = await Promise.all(overflow.slice(32))
    for (const r of results) expect(r.outcome).toBe('cancelled')
    while (resolvers.length) { resolvers.shift()!({ code: 0, label: '' }); await vi.advanceTimersByTimeAsync(0) }
    expect((await overflow[0]!).outcome).toBe('acked')

    let gate: (() => void) | null = null
    const expiring = new GuiTriggerQueue({
      fetchImpl: (_url, init) => {
        const parsed = JSON.parse(init!.body as string) as { code: number; label: string }
        return new Promise<Response>((resolve) => { gate = () => resolve(jsonResponse(ack({ label: parsed.label, code: parsed.code }))) })
      },
    })
    expiring.setContextProvider(() => CTX)
    void expiring.enqueue(1, 'held')
    const stale = expiring.enqueue(2, 'stale')
    await vi.advanceTimersByTimeAsync(2100)
    gate!()
    await vi.advanceTimersByTimeAsync(0)
    expect((await stale).outcome).toBe('cancelled')
  })

  it('aborts in-flight work as uncertain and cancels the queue on interrupt', async () => {
    const ledger: GuiTriggerLedgerRecord[] = []
    setGuiTriggerLedger((rec) => ledger.push(rec))
    let aborted = false
    const { queue } = makeQueue((_url, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    }))
    const inflight = queue.enqueue(10, 'inflight')
    const waiting = queue.enqueue(11, 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    await queue.interrupt()
    expect(aborted).toBe(true)
    expect((await inflight).outcome).toBe('uncertain')
    expect((await waiting).outcome).toBe('cancelled')
    expect(ledger.some((r) => r.kind === 'trigger_request' && r.label === 'inflight')).toBe(true)
    expect(ledger.some((r) => r.kind === 'trigger_error' && r.outcome === 'uncertain')).toBe(true)
    expect(ledger.some((r) => r.label === 'waiting' && r.kind === 'trigger_request')).toBe(false)
  })

  it('a cleared provider aborts an in-flight request promptly as uncertain', async () => {
    const ledger: GuiTriggerLedgerRecord[] = []
    setGuiTriggerLedger((rec) => ledger.push(rec))
    let aborted = false
    const { queue } = makeQueue((_url, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    }))
    const inflight = queue.enqueue(10, 'inflight')
    await vi.advanceTimersByTimeAsync(0)
    queue.setContextProvider(null)
    expect(aborted).toBe(true)
    expect((await inflight).outcome).toBe('uncertain')
    expect(ledger.some((r) => r.kind === 'trigger_error' && r.outcome === 'uncertain')).toBe(true)
  })

  it('resolves cancelled immediately when no context is installed', async () => {
    let posts = 0
    const queue = new GuiTriggerQueue({ fetchImpl: async () => { posts += 1; return jsonResponse(ack()) } })
    const result = await queue.enqueue(10, 't')
    expect(result.outcome).toBe('cancelled')
    expect(posts).toBe(0)
  })

  it('drain waits for the marker ledger to settle', async () => {
    let release: (() => void) | null = null
    const { queue } = makeQueue(() => new Promise<Response>((resolve) => {
      release = () => resolve(jsonResponse(ack()))
    }))
    void queue.enqueue(10, 'pending')
    let drained = false
    void queue.drain().then(() => { drained = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(false)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(drained).toBe(true)
  })
})

describe('SessionLogger trigger integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setGuiTriggerLedger(null)
  })
  afterEach(() => {
    setGuiTriggerLedger(null)
    vi.useRealTimers()
  })

  it('returns null for unmapped events and a future for mapped markers', async () => {
    const queue = new GuiTriggerQueue({ fetchImpl: async () => jsonResponse(ack({ code: 10 })) })
    queue.setContextProvider(() => CTX)
    void queue
    const { guiTriggerQueue } = await import('./guiTrigger')
    let ctx: GuiTriggerContext | null = CTX
    guiTriggerQueue.setContextProvider(() => ctx)
    const posts: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(String(url))
      return jsonResponse(ack({ code: 10, label: JSON.parse(init!.body as string).label }))
    }) as typeof fetch
    try {
      const logger = new SessionLogger('focus', 'S01')
      expect(logger.log('focus_trial', { trialIndex: 0 })).toBeNull()
      const marker = logger.log('session_start', {})
      expect(marker).not.toBeNull()
      const result = (await marker)!
      expect(result.outcome).toBe('acked')
      expect(posts).toHaveLength(1)
      ctx = null
      const cancelled = await logger.log('session_end', {})!
      expect(cancelled?.outcome).toBe('cancelled')
      expect(posts).toHaveLength(1)
      const other = new SessionLogger('tetris', 'S01')
      expect(other.log('session_start', {})).toBeNull()
      expect(posts).toHaveLength(1)
      expect(sessionHub.info.id).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      guiTriggerQueue.setContextProvider(null)
    }
  })
})
