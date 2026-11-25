import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GuiTriggerQueue,
  guiTriggerLabel,
  guiTriggerQueue,
  mapLogEventTrigger,
  setGuiTriggerLedger,
  validateGuiTriggerAck,
  type GuiTriggerContext,
  type GuiTriggerLedgerRecord,
} from './guiTrigger'
import { authorizeHardwareTriggerDirectory } from './hardwareTrigger'
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

  it.each([['left', 0], ['right', 1], ['up', 2], ['down', 3]] as const)(
    'maps SMR %s cue, collection onset and trial end to distinct byte codes', (target, offset) => {
      const data = { index: 7, target, live: true }
      expect(mapLogEventTrigger('smr-adapt', 'cue', data))
        .toEqual({ code: 160 + offset, trialIndex: 7, phase: 'cue' })
      expect(mapLogEventTrigger('smr-adapt', 'feedback_start', data))
        .toEqual({ code: 170 + offset, trialIndex: 7, phase: 'feedback_start' })
      expect(mapLogEventTrigger('smr-adapt', 'trial', data))
        .toEqual({ code: 180 + offset, trialIndex: 7, phase: 'trial' })
    },
  )

  it('marks SMR group boundaries and invalid trials only during real acquisition', () => {
    const data = { live: true, index: 2, target: 'left' }
    expect(mapLogEventTrigger('smr-adapt', 'session_start', data)?.code).toBe(10)
    expect(mapLogEventTrigger('smr-adapt', 'group_start', data)?.code).toBe(150)
    expect(mapLogEventTrigger('smr-adapt', 'group_end', data)?.code).toBe(151)
    expect(mapLogEventTrigger('smr-adapt', 'group_interrupted', data)?.code).toBe(152)
    expect(mapLogEventTrigger('smr-adapt', 'trial_invalid', data)?.code).toBe(190)
    expect(mapLogEventTrigger('smr-adapt', 'trial', { ...data, valid: false })?.code).toBe(190)
    expect(mapLogEventTrigger('smr-adapt', 'cue', { ...data, live: false })).toBeNull()
    expect(mapLogEventTrigger('smr-adapt', 'group_start', {})).toBeNull()
    expect(mapLogEventTrigger('smr-adapt', 'feedback_start', { ...data, target: 'constructor' })).toBeNull()
    expect(mapLogEventTrigger('smr-adapt', 'trial', { ...data, index: undefined })).toBeNull()
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

  it('prefers a prepared hardware trigger, with HTTP used only before a serial send is attempted', async () => {
    const gui = vi.fn(async () => jsonResponse(ack({ label: 'marker' })))
    const serial = vi.fn(async () => ({ ...ack(), label: undefined }))
    const failure = { reason: 'journal_not_found', message: 'Missing active event journal' }
    const prepare = vi.fn(async (): Promise<{ send: typeof serial } | typeof failure> => ({ send: serial }))
    const open = vi.fn(async () => failure)
    const queue = new GuiTriggerQueue({ fetchImpl: gui, prepareHardware: prepare, openHardware: open })
    queue.setContextProvider(() => ({ ...CTX, hardwareTrigger: true }))
    expect(serial).not.toHaveBeenCalled()
    expect(gui).not.toHaveBeenCalled()
    const completed = await queue.enqueue(10, 'marker')
    expect(completed).toMatchObject({ outcome: 'acked', transport: 'hardware_serial', ack: { sequence: 42 } })
    expect(serial).toHaveBeenCalledOnce()
    expect(gui).not.toHaveBeenCalled()

    serial.mockRejectedValueOnce(new Error('hardware_trigger_ack_timeout'))
    expect(await queue.enqueue(10, 'marker')).toMatchObject({
      outcome: 'uncertain', transport: 'hardware_serial', error: 'hardware_trigger_ack_timeout',
    })
    expect(gui).not.toHaveBeenCalled()

    const records: GuiTriggerLedgerRecord[] = []
    setGuiTriggerLedger(record => records.push(record))
    prepare.mockResolvedValueOnce(failure)
    expect(await queue.enqueue(10, 'marker')).toMatchObject({ outcome: 'acked', transport: 'gui_http', hardwareUnavailable: failure })
    expect(gui).toHaveBeenCalledOnce()
    expect(records).toMatchObject([
      { kind: 'trigger_request', transport: 'gui_http', hardwareUnavailable: failure },
      { kind: 'trigger_ack', transport: 'gui_http', hardwareUnavailable: failure },
    ])

    expect(await queue.checkHardware()).toEqual(failure)
    expect(await queue.enqueue(10, 'marker', { requireHardware: true })).toMatchObject({
      outcome: 'failed', error: 'hardware_trigger_not_prepared',
    })
    expect(records).toHaveLength(3)
    expect(records[2]).toMatchObject({ kind: 'trigger_error', error: 'hardware_trigger_not_prepared' })
    expect(gui).toHaveBeenCalledOnce()
    expect(serial).toHaveBeenCalledTimes(2)

    queue.setContextProvider(null)
    expect(await queue.checkHardware()).toMatchObject({ reason: 'no_gui_trigger_context' })
  })

  it('dispatches prepared hardware immediately and drains confirmations independently', async () => {
    let confirmFirst!: (body: unknown) => void
    const firstAck = new Promise(resolve => { confirmFirst = resolve })
    const send = vi.fn((code: number) => code === 10 ? firstAck :
      Promise.resolve(ack({ code, sequence: 43, label: undefined })))
    const open = vi.fn(async () => ({ send }))
    const gui = vi.fn()
    const queue = new GuiTriggerQueue({ fetchImpl: gui, openHardware: open })
    queue.setContextProvider(() => ({ ...CTX, hardwareTrigger: true }))
    expect(await queue.checkHardware()).toBeNull()

    const first = queue.enqueue(10, 'first', { requireHardware: true })
    const second = queue.enqueue(11, 'second', { requireHardware: true })
    expect(send.mock.calls).toEqual([[10, expect.any(AbortSignal)], [11, expect.any(AbortSignal)]])
    expect(open).toHaveBeenCalledOnce()
    expect(await second).toMatchObject({ outcome: 'acked', ack: { sequence: 43 } })
    const drained = vi.fn()
    const drain = queue.drain().then(drained)
    await Promise.resolve()
    expect(drained).not.toHaveBeenCalled()
    confirmFirst(ack({ label: undefined }))
    expect(await first).toMatchObject({ outcome: 'acked', ack: { sequence: 42 } })
    await drain
    expect(drained).toHaveBeenCalledOnce()
    expect(gui).not.toHaveBeenCalled()
  })

  it.each([[undefined, '/api/omni-gui/v1/trigger'], [8769, '/api/omni-gui/8769/v1/trigger']] as const)(
    'POSTs one trigger to the active GUI port %s and validates its ACK', async (guiPort, expectedUrl) => {
      const calls: { url: string; init?: RequestInit }[] = []
      const { queue, setCtx } = makeQueue(async (url, init) => {
        calls.push({ url, init })
        return jsonResponse(ack())
      })
      setCtx({ ...CTX, guiPort })
      const result = await queue.enqueue(10, 'pbc1|focus|ev1|0|prepare')
      expect(result.outcome).toBe('acked')
      expect(result.ack?.sequence).toBe(42)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe(expectedUrl)
      expect(calls[0]!.init?.method).toBe('POST')
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ code: 10, label: 'pbc1|focus|ev1|0|prepare' })
    },
  )

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

  it('marks N-back stimuli with prepared CH340 and preserves optional HTTP fallback', async () => {
    let connected = true
    let journal = ''
    const write = vi.fn(async (frame: Uint8Array) => {
      journal += JSON.stringify(ack({
        code: frame[1], host_time: new Date().toISOString(), label: 'stm32_hardware_trigger',
      })) + '\n'
    })
    const port = {
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      writable: new WritableStream<Uint8Array>({ write: frame => write(frame) }),
    }
    vi.stubGlobal('navigator', { serial: { getPorts: async () => connected ? [port] : [] } })
    vi.stubGlobal('window', { showDirectoryPicker: async () => ({
      name: 'recordings', queryPermission: async () => 'granted',
      getFileHandle: async () => ({ getFile: async () => new Blob([journal]) }),
    }) })
    const fetchMarker = vi.fn(async (_url: string, init?: RequestInit) =>
      jsonResponse(ack(JSON.parse(init!.body as string))))
    vi.stubGlobal('fetch', fetchMarker)
    try {
      await authorizeHardwareTriggerDirectory()
      guiTriggerQueue.setContextProvider(() => ({ ...CTX, hardwareTrigger: true, guiPort: 8769 }))
      const logger = new SessionLogger('nback', 'S01')
      expect(await guiTriggerQueue.checkHardware()).toBeNull()
      const marker = logger.log('stimulus_onset', { index: 3, scored: true, target: true }, { requireHardware: true })
      await vi.advanceTimersByTimeAsync(40)
      expect(await marker).toMatchObject({ code: 245, outcome: 'acked', transport: 'hardware_serial' })
      expect(write).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(0xa5, 245, 10))
      expect(fetchMarker).not.toHaveBeenCalled()

      connected = false
      expect(await logger.log('stimulus_onset', { index: 4, scored: true, target: false }))
        .toMatchObject({ code: 246, outcome: 'acked', transport: 'gui_http' })
      expect(await logger.log('response', { index: 4, rtMs: 302, scored: true, input: 'match' }))
        .toMatchObject({ code: 247, outcome: 'acked', transport: 'gui_http' })
      expect(fetchMarker.mock.calls[1]?.[0]).toBe('/api/omni-gui/8769/v1/trigger')
      expect(JSON.parse(fetchMarker.mock.calls[1]![1]!.body as string)).toEqual({
        code: 247, label: `pbc1|nback|${logger.getEvents().at(-1)!.eventId}|4|response`,
      })
      expect(await logger.log('stimulus_onset', { index: 0, scored: false, target: false }))
        .toMatchObject({ code: 248, outcome: 'acked', transport: 'gui_http' })
      expect(logger.log('stimulus_offset', { index: 4 })).toBeNull()
      expect(logger.log('trial_end', { index: 4 })).toBeNull()
      expect(logger.log('stimulus_onset', { index: 4, scored: true })).toBeNull()
      expect(fetchMarker).toHaveBeenCalledTimes(3)

      guiTriggerQueue.setContextProvider(null)
      expect(await logger.log('response', { index: 1 })).toMatchObject({ code: 247, outcome: 'cancelled' })
      expect(fetchMarker).toHaveBeenCalledTimes(3)
      expect(logger.getEvents().at(-1)).toMatchObject({ type: 'response', data: { index: 1 } })
    } finally {
      guiTriggerQueue.setContextProvider(null)
      vi.unstubAllGlobals()
    }
  })
})
