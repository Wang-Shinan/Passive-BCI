/** Read-only HTTP client for the OmniBCI GUI web service (api-control build). */
import { decodeGuiDataPage, type GuiDataPage } from './guiProtocol'
import { OMNI_API_SCHEMA, OMNI_STREAM_RAW, type OmniDataBatch, type OmniHello } from './protocol'
import type { OmniClientOptions } from './client'

/** GET /v1/status diagnostics; every field optional — missing means unknown, not 0. */
export type GuiStatus = {
  schema_version?: number
  connected?: boolean
  streaming?: boolean
  api_control_enabled?: boolean
  sample_rate_hz?: number
  frames?: number
  sequence_lost?: number
  frame_crc_bad?: number
  gap_events?: number
  session_id?: string
  status?: string
  stale?: boolean
  snapshot_age_ms?: number
  workers?: Record<string, unknown>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type GuiStreamContext = {
  sessionId: string
  generation: number
  segmentId: number
  channelNames: string[]
  sampleRate: number
  reset?: { reason: string; fromCursor: number | null; toCursor: number }
}

export type GuiInterruption = {
  reason: string
  detail: string
  context: GuiStreamContext | null
}

export type OmniGuiClientOptions = OmniClientOptions & {
  /** same-origin proxy prefix; the real service is http://127.0.0.1:8766 */
  basePath?: string
  fetchImpl?: FetchLike
  onGuiStatus?: (status: GuiStatus) => void
  autoRecover?: boolean
  onInterrupt?: (event: GuiInterruption) => void | Promise<void>
  onReady?: (source: GuiStreamContext) => void | Promise<void>
  onFatal?: (message: string) => void
}

const STATUS_MS = 1000
const DATA_IDLE_MS = 50
const FETCH_TIMEOUT_MS = 5000
const RECOVER_FETCH_TIMEOUT_MS = 2000
const RECOVER_RETRY_MS = 1000
const STALL_MS = 2000
const PAGE_LIMIT = 1000

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function decodeGuiStatus(value: unknown): GuiStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GUI status 必须是 JSON 对象')
  }
  const raw = value as Record<string, unknown>
  const schema = optionalNumber(raw.schema_version) ?? optionalNumber(raw.schema)
  if (schema !== OMNI_API_SCHEMA) {
    throw new Error(`GUI status schema 不兼容（${schema === undefined ? '缺失' : schema}）`)
  }
  return {
    schema_version: schema,
    connected: typeof raw.connected === 'boolean' ? raw.connected : undefined,
    streaming: typeof raw.streaming === 'boolean' ? raw.streaming : undefined,
    api_control_enabled: typeof raw.api_control_enabled === 'boolean' ? raw.api_control_enabled : undefined,
    sample_rate_hz: optionalNumber(raw.sample_rate_hz),
    frames: optionalNumber(raw.frames),
    sequence_lost: optionalNumber(raw.sequence_lost),
    frame_crc_bad: optionalNumber(raw.frame_crc_bad),
    gap_events: optionalNumber(raw.gap_events),
    session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    stale: typeof raw.stale === 'boolean' ? raw.stale : undefined,
    snapshot_age_ms: optionalNumber(raw.snapshot_age_ms),
    workers: raw.workers && typeof raw.workers === 'object' && !Array.isArray(raw.workers)
      ? (raw.workers as Record<string, unknown>)
      : undefined,
  }
}

/**
 * Polls the OmniBCI GUI HTTP service: /v1/status for diagnostics, /v1/data for
 * ordered original-device frames. GET only — never writes control or triggers.
 * Data subscription starts at the bootstrap end cursor (no history replay);
 * a 409 or generation/cursor mismatch fails visibly instead of stitching.
 */
export class OmniGuiHttpClient {
  private readonly opts: OmniGuiClientOptions
  private readonly base: string
  private readonly fetchImpl: FetchLike
  private closedByUser = true
  private runToken = 0
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private dataTimer: ReturnType<typeof setTimeout> | null = null
  private readonly inflight = new Set<AbortController>()
  private statusBusy = false
  private generation: number | null = null
  private cursor = 0
  private sessionId = 'unknown'
  private channelKey = ''
  private channelNames: string[] = []
  private sampleRate = 0
  private lastSeq: number | null = null
  private packetCount = 0
  private packetLoss = 0
  private recovering = false
  private segmentId = 0
  private lastDataAt = -1
  private epoch = 0
  private readonly wakeups = new Set<() => void>()

  constructor(opts: OmniGuiClientOptions = {}) {
    this.opts = opts
    this.base = opts.basePath ?? '/api/omni-gui'
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  }

  connect(): void {
    this.disconnect()
    this.closedByUser = false
    const token = ++this.runToken
    this.generation = null
    this.cursor = 0
    this.sessionId = 'unknown'
    this.channelKey = ''
    this.lastSeq = null
    this.packetCount = 0
    this.packetLoss = 0
    this.opts.onStatus?.('connecting', '正在连接 OmniBCI GUI HTTP 服务（127.0.0.1:8766）…')
    void this.start(token)
  }

  disconnect(): void {
    this.closedByUser = true
    this.runToken += 1
    this.recovering = false
    this.epoch += 1
    if (this.statusTimer != null) { clearTimeout(this.statusTimer); this.statusTimer = null }
    if (this.dataTimer != null) { clearTimeout(this.dataTimer); this.dataTimer = null }
    for (const ctl of this.inflight) ctl.abort()
    this.inflight.clear()
    this.statusBusy = false
    for (const wake of [...this.wakeups]) wake()
    this.wakeups.clear()
  }

  get isRecovering(): boolean {
    return this.recovering
  }

  getStreamContext(): GuiStreamContext | null {
    if (this.generation === null || this.closedByUser) return null
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      segmentId: this.segmentId,
      channelNames: [...this.channelNames],
      sampleRate: this.sampleRate,
    }
  }

  requestRecovery(reason: string): void {
    if (!this.opts.autoRecover || this.recovering || this.generation === null) return
    if (this.closedByUser) return
    this.beginRecovery(this.runToken, reason, `外部请求恢复（${reason}）`)
  }

  private alive(token: number): boolean {
    return !this.closedByUser && token === this.runToken
  }

  private fail(token: number, message: string): void {
    if (!this.alive(token)) return
    if (this.opts.onFatal) this.opts.onFatal(message)
    else this.opts.onError?.(message)
    this.opts.onStatus?.('error', message)
    this.disconnect()
  }

  private async getJson(url: string, token: number, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
    const ctl = new AbortController()
    this.inflight.add(ctl)
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await this.fetchImpl(url, { signal: ctl.signal })
      const body = res.status === 204 ? null : await res.json().catch(() => null)
      return { status: res.status, body }
    } finally {
      clearTimeout(timer)
      this.inflight.delete(ctl)
      void token
    }
  }

  /** Self-scheduling diagnostics poll: one request at a time, next tick 1s after completion. */
  private scheduleStatus(token: number, ms = STATUS_MS): void {
    if (!this.alive(token) || this.statusTimer != null) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      void this.tickStatus(token)
    }, ms)
  }

  private async tickStatus(token: number): Promise<void> {
    if (this.recovering) return
    if (!this.alive(token) || this.statusBusy) return
    this.statusBusy = true
    try {
      await this.fetchStatus(token)
    } finally {
      this.statusBusy = false
      this.scheduleStatus(token)
    }
  }

  private async fetchStatus(token: number): Promise<GuiStatus | null> {
    const epoch = this.epoch
    let status = 0
    let body: unknown = null
    try {
      const res = await this.getJson(`${this.base}/v1/status`, token,
        this.opts.autoRecover ? RECOVER_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS)
      status = res.status
      body = res.body
      if (epoch !== this.epoch || this.recovering) return null
      if (this.opts.autoRecover && this.generation !== null && status === 404) {
        this.fail(token, 'GUI /v1/status 不存在（404）；该构建未提供 api-control')
        return null
      }
      if (status !== 200 || body == null) {
        if (status >= 500 && this.opts.autoRecover && this.generation !== null && !this.recovering) {
          this.beginRecovery(token, 'status_failed', `GUI 状态查询返回 HTTP ${status}`)
          return null
        }
        throw new Error(`HTTP ${status}`)
      }
      const parsed = decodeGuiStatus(body)
      if (this.alive(token)) this.opts.onGuiStatus?.(parsed)
      if (this.alive(token) && this.opts.autoRecover && !this.recovering && this.generation !== null) {
        if (parsed.api_control_enabled !== true) {
          this.fail(token, 'GUI api-control 已停用；已停止以避免混入非托管数据')
        } else if (parsed.connected !== true || parsed.streaming !== true || !parsed.session_id) {
          this.beginRecovery(token, 'upstream_stopped', 'GUI 上报设备未连接、未在采集或会话为空')
        } else if (parsed.stale === true ||
            (parsed.snapshot_age_ms !== undefined && parsed.snapshot_age_ms > STALL_MS)) {
          this.beginRecovery(token, 'status_stale', 'GUI 状态快照过期')
        } else if (parsed.session_id !== this.sessionId) {
          this.beginRecovery(token, 'session_changed', `GUI 上游会话已变化（${parsed.session_id}≠${this.sessionId}）`)
        }
      }
      return parsed
    } catch (err) {
      if (!this.alive(token) || epoch !== this.epoch) return null
      const message = err instanceof Error ? err.message : String(err)
      if (this.opts.autoRecover && this.generation !== null && !this.recovering) {
        if (message.startsWith('GUI status')) {
          this.fail(token, message)
          return null
        }
        this.beginRecovery(token, 'status_failed', `GUI 状态查询失败：${message}`)
        return null
      }
      // Status is diagnostics: report the failure instead of freezing the last value.
      this.opts.onError?.(`GUI 状态查询失败：${message}`)
      return null
    }
  }

  private async start(token: number): Promise<void> {
    const status = await this.fetchStatus(token)
    if (!this.alive(token) || status === null) {
      if (status === null && this.alive(token)) {
        this.fail(token, '无法连接 OmniBCI GUI HTTP 服务（/v1/status）。请确认 GUI 正在运行且 8766 端口可达。')
      }
      return
    }
    if (status.api_control_enabled !== true) {
      if (typeof status.session_id === 'string') this.sessionId = status.session_id
      this.fail(token, 'GUI当前构建未启用api-control；/v1/status仅提供诊断，请使用启用api-control的GUI构建')
      return
    }
    if (typeof status.session_id === 'string') this.sessionId = status.session_id
    if (this.opts.autoRecover) {
      if (status.connected !== true || status.streaming !== true ||
          !status.session_id || status.stale === true ||
          (status.snapshot_age_ms !== undefined && status.snapshot_age_ms > STALL_MS)) {
        this.fail(token, 'GUI 未在采集或会话未就绪；请先在 GUI 中开始采集再连接')
        return
      }
    }

    try {
      const { status: code, body } = await this.getJson(`${this.base}/v1/data?limit=1`, token)
      if (!this.alive(token)) return
      if (code === 404) throw new Error('GUI /v1/data 不存在（404）；该构建未提供数据广播')
      if (code !== 200) throw new Error(`GUI /v1/data 返回 HTTP ${code}`)
      const page = decodeGuiDataPage(body)
      // Tail contract for limit=1: a malformed tail must not silently skip rows.
      if (page.nextCursor !== page.endCursor) {
        throw new Error(`尾页游标不一致（next_cursor ${page.nextCursor}≠end_cursor ${page.endCursor}）`)
      }
      // Subscribe live-only: cursor starts at the end; the historical bootstrap
      // row is intentionally not emitted.
      this.generation = page.generation
      this.cursor = page.endCursor
      this.lastSeq = page.batch.samples > 0 ? page.batch.sequence[page.batch.samples - 1]! : null
      this.channelNames = [...page.batch.channelNames]
      this.channelKey = this.channelNames.join('|')
      this.sampleRate = page.batch.sampleRate
      const hello: OmniHello = {
        type: 'hello',
        schema_version: OMNI_API_SCHEMA,
        stream: OMNI_STREAM_RAW,
        sample_rate: this.sampleRate,
        channels: [...this.channelNames],
        unit: 'uV',
        session_id: this.sessionId,
      }
      this.opts.onHello?.(hello)
      // A disconnect inside onHello must not emit 'live' or leak timers.
      if (!this.alive(token)) return
      if (this.opts.autoRecover) {
        if (page.batch.samples <= 0 || !page.batch.valid.every((v) => v === 1)) {
          this.fail(token, 'GUI 尚未产生有效数据；请先在 GUI 中开始采集再连接')
          return
        }
        try {
          await this.opts.onReady?.({
            sessionId: this.sessionId,
            generation: this.generation,
            segmentId: this.segmentId,
            channelNames: [...this.channelNames],
            sampleRate: this.sampleRate,
          })
        } catch (err) {
          this.fail(token, `GUI 就绪处理失败：${err instanceof Error ? err.message : String(err)}`)
          return
        }
        if (!this.alive(token)) return
      }
      this.opts.onStatus?.('live', `已连接 OmniBCI GUI HTTP · ${this.channelNames.length} 通道 @ ${this.sampleRate} Hz（raw）`)
      if (!this.alive(token)) return
      this.lastDataAt = performance.now()
      this.scheduleStatus(token, 0)
      this.scheduleData(token, 0)
    } catch (err) {
      this.fail(token, `GUI 数据初始化失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private scheduleData(token: number, ms: number): void {
    if (!this.alive(token)) return
    this.dataTimer = setTimeout(() => void this.pollData(token), ms)
  }

  private async pollData(token: number): Promise<void> {
    if (!this.alive(token) || this.generation === null || this.recovering) return
    const epoch = this.epoch
    const requested = this.cursor
    const gen = this.generation
    let code: number
    let body: unknown
    try {
      const res = await this.getJson(
        `${this.base}/v1/data?generation=${gen}&cursor=${requested}&limit=${PAGE_LIMIT}`,
        token,
        this.opts.autoRecover ? RECOVER_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS,
      )
      code = res.status
      body = res.body
    } catch (err) {
      if (!this.alive(token) || epoch !== this.epoch || this.recovering) return
      this.outage(token, 'transport', `GUI 数据拉取失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!this.alive(token) || epoch !== this.epoch || this.recovering) return
    if (code === 409) {
      if (!this.opts.autoRecover) {
        this.fail(token, 'GUI 数据游标过期或采集已重启（409），已停止；请重新连接。')
        return
      }
      if (!this.conflictBounds(body)) {
        this.fail(token, 'GUI 409 游标边界无效，已停止；请重新连接。')
        return
      }
      this.outage(token, 'conflict', 'GUI 数据游标过期或采集已重启（409）')
      return
    }
    if (code === 404) {
      this.fail(token, 'GUI /v1/data 不存在（404）；该构建未提供数据广播')
      return
    }
    if (code !== 200) {
      if (code >= 500) this.outage(token, 'http_error', `GUI /v1/data 返回 HTTP ${code}`)
      else this.fail(token, `GUI /v1/data 返回 HTTP ${code}`)
      return
    }
    let page: GuiDataPage
    try {
      page = decodeGuiDataPage(body)
    } catch (err) {
      this.fail(token, `GUI 数据页协议错误：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (this.channelKey && (page.batch.channelNames.join('|') !== this.channelKey || page.batch.sampleRate !== this.sampleRate)) {
      this.fail(token, 'GUI 通道布局或采样率在会话中变化，已停止以避免混排数据')
      return
    }
    if (page.generation !== gen || page.nextCursor !== requested + page.batch.samples) {
      this.outage(token, 'generation_changed',
        `GUI 数据页不连续（generation ${page.generation}≠${gen} 或 next_cursor ${page.nextCursor}≠${requested}+${page.batch.samples}）`)
      return
    }
    const batch = page.batch
    if (batch.samples > 0) {
      if (this.opts.autoRecover) {
        let last = this.lastSeq
        for (let i = 0; i < batch.samples; i++) {
          if (!batch.valid[i]) {
            this.outage(token, 'invalid_frame', 'GUI 数据帧无效标记')
            return
          }
          if (last !== null && ((batch.sequence[i]! - last) >>> 0) !== 1) {
            this.outage(token, 'sequence_gap', 'GUI 数据序号不连续')
            return
          }
          last = batch.sequence[i]!
        }
        this.lastSeq = last
        this.packetCount += 1
        this.lastDataAt = performance.now()
      } else {
        let missing = 0
        let last = this.lastSeq
        for (const seq of batch.sequence) {
          if (last !== null) {
            const delta = (seq - last) >>> 0
            if (delta > 1 && delta < 0x80000000) missing += delta - 1
          }
          last = seq
        }
        this.lastSeq = last
        this.packetLoss += missing
        this.packetCount += 1
        this.lastDataAt = performance.now()
      }
      const out: OmniDataBatch = {
        ...batch,
        sessionId: `gui-${this.sessionId}:${gen}`,
        packetCount: this.packetCount,
        packetLoss: this.packetLoss,
      }
      this.opts.onBatch?.(out)
    } else if (this.opts.autoRecover && this.lastDataAt >= 0 &&
        performance.now() - this.lastDataAt > STALL_MS) {
      this.outage(token, 'stalled', 'GUI 数据流停滞超过 2 秒')
      return
    }
    this.cursor = page.nextCursor
    // Catch up immediately while buffered rows remain; idle poll otherwise.
    this.scheduleData(token, page.nextCursor < page.endCursor ? 0 : DATA_IDLE_MS)
  }

  private outage(token: number, reason: string, detail: string): void {
    if (!this.opts.autoRecover) {
      this.fail(token, detail)
      return
    }
    this.beginRecovery(token, reason, detail)
  }

  private conflictBounds(body: unknown): { generation: number; oldest: number; end: number } | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const bounds = (body as Record<string, unknown>).bounds
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) return null
    const raw = bounds as Record<string, unknown>
    const generation = raw.generation
    const oldest = raw.oldest_cursor
    const end = raw.end_cursor
    if (![generation, oldest, end].every((v) => typeof v === 'number' && Number.isSafeInteger(v) && (v as number) >= 0)) {
      return null
    }
    if ((oldest as number) > (end as number)) return null
    return { generation: generation as number, oldest: oldest as number, end: end as number }
  }

  private beginRecovery(token: number, reason: string, detail: string): void {
    if (this.recovering || !this.alive(token)) return
    this.recovering = true
    this.epoch += 1
    if (this.dataTimer != null) { clearTimeout(this.dataTimer); this.dataTimer = null }
    if (this.statusTimer != null) { clearTimeout(this.statusTimer); this.statusTimer = null }
    for (const ctl of this.inflight) ctl.abort()
    const event: GuiInterruption = { reason, detail, context: this.getStreamContext() }
    this.opts.onStatus?.('connecting', `${detail}；正在恢复…`)
    void this.recover(token, event)
  }

  private sleep(token: number, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.wakeups.delete(wake)
        resolve(false)
      }
      const timer = setTimeout(() => {
        this.wakeups.delete(wake)
        this.dataTimer = null
        resolve(this.alive(token))
      }, ms)
      this.dataTimer = timer
      this.wakeups.add(wake)
    })
  }

  private sequenceContiguous(sequence: Uint32Array, baseline: number | null): boolean {
    for (const seq of sequence) {
      if (baseline !== null) {
        const delta = (seq - baseline) >>> 0
        if (delta !== 1) return false
      }
      baseline = seq
    }
    return true
  }

  private async recover(token: number, event: GuiInterruption): Promise<void> {
    const fromCursor = this.cursor
    const fatal = (message: string): void => {
      this.recovering = false
      this.fail(token, message)
    }
    try {
      await this.opts.onInterrupt?.(event)
    } catch (err) {
      fatal(`GUI 中断处理失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    outer:
    while (this.alive(token)) {
      if (!(await this.sleep(token, RECOVER_RETRY_MS))) return
      let status: GuiStatus | null = null
      try {
        const res = await this.getJson(`${this.base}/v1/status`, token, RECOVER_FETCH_TIMEOUT_MS)
        if (res.status === 200 && res.body != null) status = decodeGuiStatus(res.body)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('GUI')) {
          fatal(`GUI 状态协议错误：${err.message}`)
          return
        }
        status = null
      }
      if (!this.alive(token)) return
      if (status === null) continue
      if (status.api_control_enabled === false) {
        fatal('GUI当前构建未启用api-control；/v1/status仅提供诊断，请使用启用api-control的GUI构建')
        return
      }
      if (status.api_control_enabled !== true || status.connected !== true ||
          status.streaming !== true || !status.session_id || status.stale === true ||
          (status.snapshot_age_ms !== undefined && status.snapshot_age_ms > STALL_MS)) {
        continue
      }
      let tail: GuiDataPage
      try {
        const res = await this.getJson(`${this.base}/v1/data?limit=1`, token, RECOVER_FETCH_TIMEOUT_MS)
        if (res.status === 404) {
          fatal('GUI /v1/data 不存在（404）；该构建未提供数据广播')
          return
        }
        if (res.status !== 200 || res.body == null) continue
        tail = decodeGuiDataPage(res.body)
        if (tail.nextCursor !== tail.endCursor) {
          throw new Error(`尾页游标不一致（next_cursor ${tail.nextCursor}≠end_cursor ${tail.endCursor}）`)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.startsWith('GUI') || message.includes('尾页游标')) {
          fatal(`GUI 数据协议错误：${message}`)
          return
        }
        continue
      }
      if (!this.alive(token)) return
      if (this.channelKey &&
          (tail.batch.channelNames.join('|') !== this.channelKey || tail.batch.sampleRate !== this.sampleRate)) {
        fatal('GUI 通道布局或采样率在会话中变化，已停止以避免混排数据')
        return
      }
      const heldCursor = tail.endCursor
      const heldGen = tail.generation
      const heldSession = status.session_id
      while (this.alive(token)) {
        let res: { status: number; body: unknown }
        try {
          res = await this.getJson(
            `${this.base}/v1/data?generation=${heldGen}&cursor=${heldCursor}&limit=${PAGE_LIMIT}`,
            token,
            RECOVER_FETCH_TIMEOUT_MS,
          )
        } catch {
          if (!(await this.sleep(token, RECOVER_RETRY_MS))) return
          continue
        }
        if (!this.alive(token)) return
        if (res.status === 409) {
          if (!this.conflictBounds(res.body)) {
            fatal('GUI 409 游标边界无效，已停止；请重新连接。')
            return
          }
          continue outer
        }
        if (res.status === 404) {
          fatal('GUI /v1/data 不存在（404）；该构建未提供数据广播')
          return
        }
        if (res.status !== 200 || res.body == null) {
          if (!(await this.sleep(token, RECOVER_RETRY_MS))) return
          continue
        }
        let page: GuiDataPage
        try {
          page = decodeGuiDataPage(res.body)
        } catch (err) {
          fatal(`GUI 数据页协议错误：${err instanceof Error ? err.message : String(err)}`)
          return
        }
        if (page.generation !== heldGen) continue outer
        if (page.nextCursor !== heldCursor + page.batch.samples) continue outer
        if (this.channelKey &&
            (page.batch.channelNames.join('|') !== this.channelKey || page.batch.sampleRate !== this.sampleRate)) {
          fatal('GUI 通道布局或采样率在会话中变化，已停止以避免混排数据')
          return
        }
        if (page.batch.samples <= 0) {
          if (!(await this.sleep(token, RECOVER_RETRY_MS))) return
          continue
        }
        if (!this.sequenceContiguous(page.batch.sequence, null) ||
            !page.batch.valid.every((v) => v === 1)) {
          continue outer
        }
        let confirm: GuiStatus | null = null
        try {
          const r = await this.getJson(`${this.base}/v1/status`, token, RECOVER_FETCH_TIMEOUT_MS)
          if (r.status === 200 && r.body != null) confirm = decodeGuiStatus(r.body)
        } catch {
          confirm = null
        }
        if (!this.alive(token)) return
        if (confirm === null || confirm.api_control_enabled !== true ||
            confirm.connected !== true || confirm.streaming !== true ||
            confirm.session_id !== heldSession || confirm.stale === true ||
            (confirm.snapshot_age_ms !== undefined && confirm.snapshot_age_ms > STALL_MS)) {
          continue outer
        }
        this.generation = heldGen
        this.cursor = page.nextCursor
        this.sessionId = heldSession
        this.segmentId += 1
        const context: GuiStreamContext = {
          sessionId: this.sessionId,
          generation: this.generation,
          segmentId: this.segmentId,
          channelNames: [...this.channelNames],
          sampleRate: this.sampleRate,
          reset: { reason: event.reason, fromCursor, toCursor: heldCursor },
        }
        try {
          await this.opts.onReady?.(context)
        } catch (err) {
          fatal(`GUI 恢复处理失败：${err instanceof Error ? err.message : String(err)}`)
          return
        }
        if (!this.alive(token)) return
        this.lastSeq = null
        for (const seq of page.batch.sequence) this.lastSeq = seq
        this.packetCount += 1
        this.lastDataAt = performance.now()
        this.recovering = false
        const out: OmniDataBatch = {
          ...page.batch,
          sessionId: `gui-${this.sessionId}:${this.generation}`,
          packetCount: this.packetCount,
          packetLoss: this.packetLoss,
        }
        this.opts.onBatch?.(out)
        this.opts.onStatus?.('live', `已恢复 OmniBCI GUI HTTP · ${this.channelNames.length} 通道 @ ${this.sampleRate} Hz（raw）`)
        this.scheduleStatus(token, 0)
        this.scheduleData(token, page.nextCursor < page.endCursor ? 0 : DATA_IDLE_MS)
        return
      }
    }
  }
}
