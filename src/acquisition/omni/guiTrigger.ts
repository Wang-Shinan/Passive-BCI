import type { FetchLike } from './guiClient'

export type GuiTriggerContext = {
  localRecordingId: string
  upstreamSessionId: string
  generation: number
  segmentId: number
}

export type GuiTriggerAck = {
  accepted: boolean
  session_id?: string
  sequence?: number
  sample_index?: number
  code?: number
  label?: string
  host_time?: string
  [key: string]: unknown
}

export type GuiTriggerOutcome = 'acked' | 'failed' | 'uncertain' | 'cancelled'

export type GuiTriggerResult = {
  outcome: GuiTriggerOutcome
  code: number
  label: string
  context: GuiTriggerContext | null
  ack?: GuiTriggerAck
  error?: string
  sourceEventId?: string
  requestedAtMs: number
  completedAtMs: number
}

export type GuiTriggerLedgerRecord = {
  kind: 'trigger_request' | 'trigger_ack' | 'trigger_error'
  localRecordingId: string
  sourceEventId?: string
  sourceExperiment?: string
  sourceTms?: number
  sourcePerfMs?: number
  code: number
  label: string
  context: GuiTriggerContext
  outcome?: GuiTriggerOutcome
  sequence?: number
  sample_index?: number
  host_time?: string
  error?: string
  requestedAtMs: number
  dispatchedAtMs?: number
  completedAtMs?: number
}

export const GUI_TRIGGER_TIMEOUT_MS = 2000
export const GUI_TRIGGER_MAX_QUEUED = 32
export const GUI_TRIGGER_MAX_AGE_MS = 2000

const COMMON_CODES: Record<string, number> = {
  session_start: 10,
  session_end: 11,
  session_abort: 12,
  acquisition_interrupted: 13,
  acquisition_resumed: 14,
}
const FOCUS_PHASE_CODE: Record<string, number> = { prepare: 100, cue: 110, collect: 120, recovery: 130 }
const JAW_PHASE_CODE: Record<string, number> = { prepare: 200, cue: 210, collect: 220, recovery: 230 }
const FOCUS_CLASS: Record<string, number> = { relax: 0, focus: 1 }
const JAW_CLASS: Record<string, number> = { relax: 0, clench: 1 }

export type GuiTriggerMapped = { code: number; trialIndex: number | null; phase: string | null }

export function mapLogEventTrigger(
  experiment: string,
  type: string,
  data?: Record<string, unknown>,
): GuiTriggerMapped | null {
  const focus = experiment === 'focus'
  const jaw = experiment === 'jaw-clench'
  if (!focus && !jaw) return null
  if (Object.prototype.hasOwnProperty.call(COMMON_CODES, type)) {
    return { code: COMMON_CODES[type]!, trialIndex: null, phase: null }
  }
  const phaseType = focus ? 'focus_phase' : 'jaw_phase'
  const phaseCode = focus ? FOCUS_PHASE_CODE : JAW_PHASE_CODE
  const classes = focus ? FOCUS_CLASS : JAW_CLASS
  if (type === phaseType) {
    const phase = typeof data?.phase === 'string' ? data.phase : null
    const base = phase && Object.prototype.hasOwnProperty.call(phaseCode, phase) ? phaseCode[phase] : undefined
    if (base === undefined) return null
    let code = base
    if (phase === 'collect') {
      const label = typeof data?.instructedLabel === 'string' ? data.instructedLabel : null
      const classId = label && Object.prototype.hasOwnProperty.call(classes, label) ? classes[label] : undefined
      if (classId === undefined) return null
      code += classId
    }
    const trialIndex = typeof data?.trialIndex === 'number' && Number.isInteger(data.trialIndex)
      ? data.trialIndex
      : null
    return { code, trialIndex, phase }
  }
  if (type === (focus ? 'focus_invalid' : 'jaw_invalid')) {
    const trialIndex = typeof data?.trialIndex === 'number' && Number.isInteger(data.trialIndex)
      ? data.trialIndex
      : null
    return { code: focus ? 140 : 240, trialIndex, phase: null }
  }
  return null
}

export function guiTriggerLabel(
  experiment: string,
  eventId: string,
  mapped: GuiTriggerMapped,
): string {
  const raw = `pbc1|${experiment}|${eventId}|${mapped.trialIndex ?? '-'}|${mapped.phase ?? '-'}`
  return raw.replace(/[^\x20-\x7e]+/g, '_').slice(0, 128)
}

function sameContext(a: GuiTriggerContext, b: GuiTriggerContext): boolean {
  return a.localRecordingId === b.localRecordingId &&
    a.upstreamSessionId === b.upstreamSessionId &&
    a.generation === b.generation &&
    a.segmentId === b.segmentId
}

function uint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
}

export function validateGuiTriggerAck(
  body: unknown,
  request: { code: number; label: string; context: GuiTriggerContext },
): { ok: true; ack: GuiTriggerAck } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'ack_not_object' }
  }
  const raw = body as Record<string, unknown>
  if (raw.accepted !== true) return { ok: false, reason: 'ack_not_accepted' }
  if (typeof raw.session_id !== 'string' || raw.session_id.length === 0 ||
      raw.session_id !== request.context.upstreamSessionId) {
    return { ok: false, reason: 'ack_session_mismatch' }
  }
  if (!uint32(raw.sequence)) return { ok: false, reason: 'ack_bad_sequence' }
  if (typeof raw.sample_index !== 'number' || !Number.isSafeInteger(raw.sample_index) || raw.sample_index < 0) {
    return { ok: false, reason: 'ack_bad_sample_index' }
  }
  if (raw.code !== request.code) return { ok: false, reason: 'ack_code_mismatch' }
  if (raw.label !== undefined && raw.label !== request.label) {
    return { ok: false, reason: 'ack_label_mismatch' }
  }
  if (typeof raw.host_time !== 'string' || raw.host_time.length === 0 ||
      !Number.isFinite(Date.parse(raw.host_time))) {
    return { ok: false, reason: 'ack_bad_host_time' }
  }
  const ack: GuiTriggerAck = {
    accepted: true,
    session_id: raw.session_id,
    sequence: raw.sequence,
    sample_index: raw.sample_index,
    code: raw.code,
    ...(raw.label !== undefined ? { label: raw.label as string } : {}),
    host_time: raw.host_time,
  }
  return { ok: true, ack }
}

type LedgerSink = (record: GuiTriggerLedgerRecord) => void
let ledgerSink: LedgerSink | null = null
export function setGuiTriggerLedger(sink: LedgerSink | null): void {
  ledgerSink = sink
}
function ledger(record: GuiTriggerLedgerRecord): void {
  try { ledgerSink?.(record) } catch {}
}

type Pending = {
  code: number
  label: string
  context: GuiTriggerContext
  sourceEventId?: string
  sourceExperiment?: string
  sourceTms?: number
  sourcePerfMs?: number
  enqueuedAtMs: number
  requestedAtMs: number
  dispatchedAtMs?: number
  resolve: (result: GuiTriggerResult) => void
}

export class GuiTriggerQueue {
  private provider: (() => GuiTriggerContext | null) | null = null
  private pending: Pending[] = []
  private inflight: { ctl: AbortController; req: Pending } | null = null
  private idleWaiters = new Set<() => void>()
  private readonly base: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(opts?: { basePath?: string; fetchImpl?: FetchLike; now?: () => number }) {
    this.base = opts?.basePath ?? '/api/omni-gui'
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = opts?.now ?? (() => performance.now())
  }

  setContextProvider(provider: (() => GuiTriggerContext | null) | null): void {
    this.provider = provider
    if (!provider) {
      this.cancelQueued('context_cleared')
      this.inflight?.ctl.abort()
    }
  }

  private result(req: Pending | { code: number; label: string; context: GuiTriggerContext | null; requestedAtMs: number; sourceEventId?: string },
    outcome: GuiTriggerOutcome, extra?: { ack?: GuiTriggerAck; error?: string }): GuiTriggerResult {
    return {
      outcome,
      code: req.code,
      label: req.label,
      context: req.context,
      ack: extra?.ack,
      error: extra?.error,
      sourceEventId: req.sourceEventId,
      requestedAtMs: req.requestedAtMs,
      completedAtMs: this.now(),
    }
  }

  private emitCancelled(req: Pending, error: string): void {
    ledger({
      kind: 'trigger_error',
      localRecordingId: req.context.localRecordingId,
      sourceEventId: req.sourceEventId,
      sourceExperiment: req.sourceExperiment,
      sourceTms: req.sourceTms,
      sourcePerfMs: req.sourcePerfMs,
      code: req.code,
      label: req.label,
      context: req.context,
      outcome: 'cancelled',
      error,
      requestedAtMs: req.requestedAtMs,
      completedAtMs: this.now(),
    })
    this.settle(req, 'cancelled', { error })
  }

  enqueue(code: number, label: string, meta?: { sourceEventId?: string; sourceExperiment?: string; sourceTms?: number
  sourcePerfMs?: number }): Promise<GuiTriggerResult> {
    const requestedAtMs = this.now()
    const context = this.provider?.() ?? null
    if (!context) {
      return Promise.resolve(this.result(
        { code, label, context: null, requestedAtMs, sourceEventId: meta?.sourceEventId },
        'cancelled',
        { error: 'no_gui_trigger_context' },
      ))
    }
    if (this.pending.length >= GUI_TRIGGER_MAX_QUEUED) {
      const req: Pending = {
        code, label, context, sourceEventId: meta?.sourceEventId,
        sourceExperiment: meta?.sourceExperiment, sourceTms: meta?.sourceTms, sourcePerfMs: meta?.sourcePerfMs,
        enqueuedAtMs: requestedAtMs, requestedAtMs, resolve: () => {},
      }
      const result = this.result(req, 'cancelled', { error: 'queue_overflow' })
      this.emitCancelled(req, 'queue_overflow')
      return Promise.resolve(result)
    }
    return new Promise<GuiTriggerResult>((resolve) => {
      this.pending.push({
        code, label, context, sourceEventId: meta?.sourceEventId,
        sourceExperiment: meta?.sourceExperiment, sourceTms: meta?.sourceTms, sourcePerfMs: meta?.sourcePerfMs,
        enqueuedAtMs: this.now(), requestedAtMs, resolve,
      })
      this.pump()
    })
  }

  private settle(req: Pending, outcome: GuiTriggerOutcome, extra?: { ack?: GuiTriggerAck; error?: string }): void {
    req.resolve(this.result(req, outcome, extra))
    this.notifyIdle()
  }

  private cancelQueued(error: string): void {
    const queued = this.pending.splice(0)
    for (const req of queued) this.emitCancelled(req, error)
  }

  private pump(): void {
    if (this.inflight || !this.pending.length) {
      this.notifyIdle()
      return
    }
    const req = this.pending.shift()!
    const live = this.provider?.() ?? null
    if (!live || !sameContext(live, req.context)) {
      this.emitCancelled(req, 'context_changed')
      this.pump()
      return
    }
    if (this.now() - req.enqueuedAtMs > GUI_TRIGGER_MAX_AGE_MS) {
      this.emitCancelled(req, 'queue_expired')
      this.pump()
      return
    }
    const ctl = new AbortController()
    this.inflight = { ctl, req }
    req.dispatchedAtMs = this.now()
    ledger({
      kind: 'trigger_request',
      localRecordingId: req.context.localRecordingId,
      sourceEventId: req.sourceEventId,
      sourceExperiment: req.sourceExperiment,
      sourceTms: req.sourceTms,
      sourcePerfMs: req.sourcePerfMs,
      code: req.code,
      label: req.label,
      context: req.context,
      requestedAtMs: req.requestedAtMs,
      dispatchedAtMs: req.dispatchedAtMs,
    })
    const timer = setTimeout(() => ctl.abort(), GUI_TRIGGER_TIMEOUT_MS)
    const done = (async () => {
      let outcome: GuiTriggerOutcome
      let ack: GuiTriggerAck | undefined
      let error: string | undefined
      try {
        const res = await this.fetchImpl(`${this.base}/v1/trigger`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: req.code, label: req.label }),
          signal: ctl.signal,
        })
        const body = res.status === 204 ? null : await res.json().catch(() => null)
        if (res.status >= 400 && res.status < 500) {
          outcome = 'failed'
          error = `trigger rejected (HTTP ${res.status})`
        } else if (res.status !== 200) {
          outcome = 'uncertain'
          error = `trigger status ${res.status}`
        } else {
          const check = validateGuiTriggerAck(body, req)
          if (check.ok) {
            const latest = this.provider?.() ?? null
            if (ctl.signal.aborted) {
              outcome = 'uncertain'
              error = 'aborted_after_dispatch'
            } else if (!latest || !sameContext(latest, req.context)) {
              outcome = 'uncertain'
              error = 'context_changed_after_dispatch'
            } else {
              outcome = 'acked'
              ack = check.ack
            }
          } else {
            outcome = 'uncertain'
            error = check.reason
          }
        }
      } catch (err) {
        outcome = 'uncertain'
        error = err instanceof Error ? err.message : String(err)
      } finally {
        clearTimeout(timer)
        this.inflight = null
      }
      ledger({
        kind: outcome === 'acked' ? 'trigger_ack' : 'trigger_error',
        localRecordingId: req.context.localRecordingId,
        sourceEventId: req.sourceEventId,
        sourceExperiment: req.sourceExperiment,
        sourceTms: req.sourceTms,
      sourcePerfMs: req.sourcePerfMs,
        code: req.code,
        label: req.label,
        context: req.context,
        outcome,
        sequence: ack?.sequence,
        sample_index: ack?.sample_index,
        host_time: ack?.host_time,
        error,
        requestedAtMs: req.requestedAtMs,
        dispatchedAtMs: req.dispatchedAtMs,
        completedAtMs: this.now(),
      })
      this.settle(req, outcome, { ack, error })
      this.pump()
    })()
    this.inflightDone = done
    void done
  }

  private inflightDone: Promise<void> | null = null

  async interrupt(): Promise<void> {
    const current = this.inflight
    this.cancelQueued('acquisition_interrupted')
    if (current) {
      current.ctl.abort()
      await this.inflightDone
    }
  }

  async drain(): Promise<void> {
    while (this.pending.length || this.inflight) {
      this.pump()
      if (!this.pending.length && !this.inflight) break
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve)
      })
    }
  }

  private notifyIdle(): void {
    if (this.pending.length || this.inflight) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

export const guiTriggerQueue = new GuiTriggerQueue()

export async function drainGuiTriggers(): Promise<void> {
  await guiTriggerQueue.drain()
}
