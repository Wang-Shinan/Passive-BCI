import type { FetchLike } from './guiClient'
import { OMNI_GUI_PROXY_PATH, omniGuiProxyPath } from './guiEndpoint'
import {
  openHardwareTrigger, prepareHardwareTrigger,
  type HardwareTriggerFailure, type HardwareTriggerLink, type OpenHardwareTrigger, type PrepareHardwareTrigger,
} from './hardwareTrigger'

export type GuiTriggerContext = {
  localRecordingId: string
  upstreamSessionId: string
  generation: number
  segmentId: number
  guiPort?: number
  hardwareTrigger?: boolean
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
export type GuiTriggerTransport = 'gui_http' | 'hardware_serial'

type TriggerCompletion = {
  ack?: GuiTriggerAck
  transport?: GuiTriggerTransport
  error?: string
  hardwareUnavailable?: HardwareTriggerFailure
}

export type GuiTriggerResult = TriggerCompletion & {
  outcome: GuiTriggerOutcome
  code: number
  label: string
  context: GuiTriggerContext | null
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
  transport?: GuiTriggerTransport
  sequence?: number
  sample_index?: number
  host_time?: string
  error?: string
  hardwareUnavailable?: HardwareTriggerFailure
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
const SMR_GROUP_CODE = { group_start: 150, group_end: 151, group_interrupted: 152 }
const SMR_TRIAL_BASE = { cue: 160, feedback_start: 170, trial: 180 }
const SMR_TARGET_OFFSET = { left: 0, right: 1, up: 2, down: 3 }
const NBACK_CODES = { target: 245, nonTarget: 246, response: 247, warmup: 248 }

export type GuiTriggerMapped = { code: number; trialIndex: number | null; phase: string | null }

export function mapLogEventTrigger(
  experiment: string,
  type: string,
  data?: Record<string, unknown>,
): GuiTriggerMapped | null {
  if (experiment === 'nback') {
    const trialIndex = data?.index
    if (typeof trialIndex !== 'number' || !Number.isSafeInteger(trialIndex) || trialIndex < 0) return null
    if (type === 'response') return { code: NBACK_CODES.response, trialIndex, phase: type }
    if (type !== 'stimulus_onset') return null
    if (data?.scored === false) return { code: NBACK_CODES.warmup, trialIndex, phase: type }
    if (data?.scored !== true || typeof data.target !== 'boolean') return null
    return { code: data.target ? NBACK_CODES.target : NBACK_CODES.nonTarget, trialIndex, phase: type }
  }
  if (experiment === 'smr-adapt' || experiment === 'smr-feet' || experiment === 'smr-jaw') {
    if (data?.live !== true) return null
    if (type === 'session_start') return { code: COMMON_CODES.session_start!, trialIndex: null, phase: null }
    const trialIndex = typeof data.index === 'number' && Number.isInteger(data.index) ? data.index : null
    if (Object.hasOwn(SMR_GROUP_CODE, type)) {
      return { code: SMR_GROUP_CODE[type as keyof typeof SMR_GROUP_CODE], trialIndex, phase: type }
    }
    if (trialIndex === null) return null
    if (type === 'trial_invalid' || (type === 'trial' && data.valid === false)) {
      return { code: 190, trialIndex, phase: 'trial_invalid' }
    }
    const target = data.target
    if (experiment !== 'smr-adapt') {
      const feet = experiment === 'smr-feet'
      if (target !== (feet ? 'feet' : 'jaw') || !Object.hasOwn(SMR_TRIAL_BASE, type)) return null
      return { code: SMR_TRIAL_BASE[type as keyof typeof SMR_TRIAL_BASE] + (feet ? 4 : 5), trialIndex, phase: type }
    }
    if (!Object.hasOwn(SMR_TRIAL_BASE, type) || typeof target !== 'string' || !Object.hasOwn(SMR_TARGET_OFFSET, target)) return null
    return {
      code: SMR_TRIAL_BASE[type as keyof typeof SMR_TRIAL_BASE] + SMR_TARGET_OFFSET[target as keyof typeof SMR_TARGET_OFFSET],
      trialIndex,
      phase: type,
    }
  }
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
    a.segmentId === b.segmentId &&
    a.guiPort === b.guiPort &&
    a.hardwareTrigger === b.hardwareTrigger
}

function uint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
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

const noHardwareContext: HardwareTriggerFailure = {
  reason: 'no_gui_trigger_context', message: '请先在 OmniBCI GUI 开始采集，在 N-back 页点「开始本局」，确认网页正在录制。',
}

function triggerRecord(req: Pending) {
  return {
    localRecordingId: req.context.localRecordingId,
    sourceEventId: req.sourceEventId,
    sourceExperiment: req.sourceExperiment,
    sourceTms: req.sourceTms,
    sourcePerfMs: req.sourcePerfMs,
    code: req.code,
    label: req.label,
    context: req.context,
    requestedAtMs: req.requestedAtMs,
  }
}

export class GuiTriggerQueue {
  private provider: (() => GuiTriggerContext | null) | null = null
  private pending: Pending[] = []
  private inflight: { ctl: AbortController; req: Pending } | null = null
  private idleWaiters = new Set<() => void>()
  private readonly base: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly prepareHardware?: PrepareHardwareTrigger
  private readonly openHardware?: OpenHardwareTrigger
  private armedHardware: { context: GuiTriggerContext; link: HardwareTriggerLink } | null = null
  private hardwareInFlight = new Map<AbortController, Promise<void>>()

  constructor(opts?: {
    basePath?: string; fetchImpl?: FetchLike; now?: () => number
    prepareHardware?: PrepareHardwareTrigger; openHardware?: OpenHardwareTrigger
  }) {
    this.base = opts?.basePath ?? OMNI_GUI_PROXY_PATH
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = opts?.now ?? (() => performance.now())
    this.prepareHardware = opts?.prepareHardware
    this.openHardware = opts?.openHardware
  }

  setContextProvider(provider: (() => GuiTriggerContext | null) | null): void {
    this.provider = provider
    if (!provider) {
      this.cancelQueued('context_cleared')
      this.inflight?.ctl.abort()
      this.armedHardware = null
      for (const ctl of this.hardwareInFlight.keys()) ctl.abort()
    }
  }

  private prepareTrigger(context: GuiTriggerContext, code: number, signal: AbortSignal) {
    if (!context.hardwareTrigger || !this.prepareHardware) {
      return Promise.resolve<HardwareTriggerFailure>({
        reason: 'hardware_trigger_unsupported', message: '当前 EEG 会话不支持 CH340 打标，请检查 STM32 采集和 GUI HTTP 链路。',
      })
    }
    return withAbort(this.prepareHardware({ code, sessionId: context.upstreamSessionId, signal }), signal)
  }

  async checkHardware(): Promise<HardwareTriggerFailure | null> {
    this.armedHardware = null
    const context = this.provider?.()
    if (!context) return noHardwareContext
    if (!context.hardwareTrigger || !this.openHardware) {
      return { reason: 'hardware_trigger_unsupported', message: '当前 EEG 会话不支持 CH340 打标，请检查 STM32 采集和 GUI HTTP 链路。' }
    }
    await this.drain()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), GUI_TRIGGER_TIMEOUT_MS)
    try {
      const result = await withAbort(this.openHardware({ sessionId: context.upstreamSessionId, signal: ctl.signal }), ctl.signal)
      const current = this.provider?.()
      if (!current || !sameContext(context, current)) return noHardwareContext
      if (!('send' in result)) return result
      this.armedHardware = { context, link: result }
      return null
    } catch {
      return { reason: 'hardware_check_failed', message: '检查 CH340 链路失败或超时，请检查串口和录制目录。' }
    } finally {
      clearTimeout(timer)
    }
  }

  private result(req: Pending | { code: number; label: string; context: GuiTriggerContext | null; requestedAtMs: number; sourceEventId?: string },
    outcome: GuiTriggerOutcome, extra?: TriggerCompletion): GuiTriggerResult {
    return {
      outcome,
      code: req.code,
      label: req.label,
      context: req.context,
      ack: extra?.ack,
      transport: extra?.transport,
      error: extra?.error,
      hardwareUnavailable: extra?.hardwareUnavailable,
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
  sourcePerfMs?: number; requireHardware?: boolean }): Promise<GuiTriggerResult> {
    const requestedAtMs = this.now()
    const context = this.provider?.() ?? null
    if (!context) {
      return Promise.resolve(this.result(
        { code, label, context: null, requestedAtMs, sourceEventId: meta?.sourceEventId },
        'cancelled',
        { error: noHardwareContext.reason, ...(meta?.requireHardware ? { hardwareUnavailable: noHardwareContext } : {}) },
      ))
    }
    const queued = meta?.requireHardware ? this.hardwareInFlight.size : this.pending.length
    if (queued >= GUI_TRIGGER_MAX_QUEUED) {
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
      const req: Pending = {
        code, label, context, sourceEventId: meta?.sourceEventId,
        sourceExperiment: meta?.sourceExperiment, sourceTms: meta?.sourceTms, sourcePerfMs: meta?.sourcePerfMs,
        enqueuedAtMs: this.now(), requestedAtMs, resolve,
      }
      if (meta?.requireHardware) this.sendArmedHardware(req)
      else {
        this.pending.push(req)
        this.pump()
      }
    })
  }

  private sendArmedHardware(req: Pending): void {
    const armed = this.armedHardware
    if (!armed || !sameContext(armed.context, req.context)) {
      const hardwareUnavailable = { reason: 'hardware_trigger_not_prepared', message: 'CH340 打标未准备好或 EEG 会话已变化。' }
      this.complete(req, 'failed', { error: hardwareUnavailable.reason, hardwareUnavailable })
      return
    }
    const ctl = new AbortController()
    const transport = 'hardware_serial'
    req.dispatchedAtMs = this.now()
    let confirmation: Promise<unknown>
    try { confirmation = armed.link.send(req.code, ctl.signal) }
    catch (error) {
      this.complete(req, 'uncertain', { transport, error: error instanceof Error ? error.message : String(error) })
      return
    }

    const timer = setTimeout(() => ctl.abort(new Error('trigger_timeout')), GUI_TRIGGER_TIMEOUT_MS)
    const done = withAbort(confirmation, ctl.signal)
      .then(body => {
        const check = validateGuiTriggerAck(body, req)
        const latest = this.provider?.()
        if (!check.ok) this.complete(req, 'uncertain', { transport, error: check.reason })
        else if (ctl.signal.aborted) this.complete(req, 'uncertain', { transport, error: 'aborted_after_dispatch' })
        else if (!latest || !sameContext(latest, req.context)) {
          this.complete(req, 'uncertain', { transport, error: 'context_changed_after_dispatch' })
        } else this.complete(req, 'acked', { transport, ack: check.ack })
      })
      .catch(error => {
        this.complete(req, 'uncertain', { transport, error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => {
        clearTimeout(timer)
        this.hardwareInFlight.delete(ctl)
        this.notifyIdle()
      })
    this.hardwareInFlight.set(ctl, done)
    ledger({ ...triggerRecord(req), kind: 'trigger_request', transport, dispatchedAtMs: req.dispatchedAtMs })
  }

  private complete(req: Pending, outcome: GuiTriggerOutcome, extra: TriggerCompletion): void {
    ledger({
      ...triggerRecord(req),
      kind: outcome === 'acked' ? 'trigger_ack' : 'trigger_error',
      transport: extra.transport,
      outcome,
      sequence: extra.ack?.sequence,
      sample_index: extra.ack?.sample_index,
      host_time: extra.ack?.host_time,
      error: extra.error,
      hardwareUnavailable: extra.hardwareUnavailable,
      dispatchedAtMs: req.dispatchedAtMs,
      completedAtMs: this.now(),
    })
    this.settle(req, outcome, extra)
  }

  private settle(req: Pending, outcome: GuiTriggerOutcome, extra?: TriggerCompletion): void {
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
    const record = triggerRecord(req)
    const timer = setTimeout(() => ctl.abort(new Error('trigger_timeout')), GUI_TRIGGER_TIMEOUT_MS)
    const done = (async () => {
      let outcome: GuiTriggerOutcome = 'uncertain'
      let ack: GuiTriggerAck | undefined
      let error: string | undefined
      let transport: GuiTriggerTransport | undefined
      let hardwareUnavailable: HardwareTriggerFailure | undefined
      try {
        const preparation = req.context.hardwareTrigger
          ? await this.prepareTrigger(req.context, req.code, ctl.signal) : null
        const hardware = preparation && 'send' in preparation ? preparation.send : undefined
        if (preparation && 'reason' in preparation) hardwareUnavailable = preparation
        const before = this.provider?.() ?? null
        if (ctl.signal.aborted || !before || !sameContext(before, req.context)) {
          outcome = 'cancelled'
          error = 'context_changed_before_dispatch'
        } else {
          transport = hardware ? 'hardware_serial' : 'gui_http'
          req.dispatchedAtMs = this.now()
          ledger({ ...record, kind: 'trigger_request', transport, hardwareUnavailable, dispatchedAtMs: req.dispatchedAtMs })
          let body: unknown
          if (hardware) {
            body = await withAbort(hardware(), ctl.signal)
          } else {
            const base = req.context.guiPort === undefined ? this.base : omniGuiProxyPath(req.context.guiPort)
            const res = await this.fetchImpl(`${base}/v1/trigger`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: req.code, label: req.label }),
              signal: ctl.signal,
            })
            if (res.status >= 400 && res.status < 500) {
              outcome = 'failed'
              error = `trigger rejected (HTTP ${res.status})`
            } else if (res.status !== 200) {
              error = `trigger status ${res.status}`
            } else {
              body = await res.json().catch(() => null)
            }
          }
          if (!error) {
            const check = validateGuiTriggerAck(body, req)
            const latest = this.provider?.() ?? null
            if (!check.ok) error = check.reason
            else if (ctl.signal.aborted) error = 'aborted_after_dispatch'
            else if (!latest || !sameContext(latest, req.context)) error = 'context_changed_after_dispatch'
            else {
              outcome = 'acked'
              ack = check.ack
            }
          }
        }
      } catch (err) {
        if (transport === undefined && ctl.signal.aborted) outcome = 'cancelled'
        error = err instanceof Error ? err.message : String(err)
      } finally {
        clearTimeout(timer)
        this.inflight = null
      }
      this.complete(req, outcome, { ack, error, transport, hardwareUnavailable })
      this.pump()
    })()
    this.inflightDone = done
    void done
  }

  private inflightDone: Promise<void> | null = null

  async interrupt(): Promise<void> {
    const current = this.inflight
    this.armedHardware = null
    this.cancelQueued('acquisition_interrupted')
    for (const ctl of this.hardwareInFlight.keys()) ctl.abort()
    current?.ctl.abort()
    await Promise.all([...(current ? [this.inflightDone] : []), ...this.hardwareInFlight.values()])
  }

  async drain(): Promise<void> {
    while (this.pending.length || this.inflight || this.hardwareInFlight.size) {
      this.pump()
      if (!this.pending.length && !this.inflight && !this.hardwareInFlight.size) break
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve)
      })
    }
  }

  private notifyIdle(): void {
    if (this.pending.length || this.inflight || this.hardwareInFlight.size) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

export const guiTriggerQueue = new GuiTriggerQueue({ prepareHardware: prepareHardwareTrigger, openHardware: openHardwareTrigger })

export async function drainGuiTriggers(): Promise<void> {
  await guiTriggerQueue.drain()
}
