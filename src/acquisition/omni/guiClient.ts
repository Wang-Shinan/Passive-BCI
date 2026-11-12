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

export type OmniGuiClientOptions = OmniClientOptions & {
  /** same-origin proxy prefix; the real service is http://127.0.0.1:8766 */
  basePath?: string
  fetchImpl?: FetchLike
  onGuiStatus?: (status: GuiStatus) => void
}

const STATUS_MS = 1000
const DATA_IDLE_MS = 50
const FETCH_TIMEOUT_MS = 5000
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
    if (this.statusTimer != null) { clearTimeout(this.statusTimer); this.statusTimer = null }
    if (this.dataTimer != null) { clearTimeout(this.dataTimer); this.dataTimer = null }
    for (const ctl of this.inflight) ctl.abort()
    this.inflight.clear()
    this.statusBusy = false
  }

  private alive(token: number): boolean {
    return !this.closedByUser && token === this.runToken
  }

  private fail(token: number, message: string): void {
    if (!this.alive(token)) return
    this.opts.onError?.(message)
    this.opts.onStatus?.('error', message)
    this.disconnect()
  }

  private async getJson(url: string, token: number): Promise<{ status: number; body: unknown }> {
    const ctl = new AbortController()
    this.inflight.add(ctl)
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
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
    try {
      const { status, body } = await this.getJson(`${this.base}/v1/status`, token)
      if (status !== 200 || body == null) throw new Error(`HTTP ${status}`)
      const parsed = decodeGuiStatus(body)
      if (this.alive(token)) this.opts.onGuiStatus?.(parsed)
      return parsed
    } catch (err) {
      if (!this.alive(token)) return null
      // Status is diagnostics: report the failure instead of freezing the last value.
      this.opts.onError?.(`GUI 状态查询失败：${err instanceof Error ? err.message : String(err)}`)
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
      this.opts.onStatus?.('live', `已连接 OmniBCI GUI HTTP · ${this.channelNames.length} 通道 @ ${this.sampleRate} Hz（raw）`)
      if (!this.alive(token)) return
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
    if (!this.alive(token) || this.generation === null) return
    const requested = this.cursor
    const gen = this.generation
    let code: number
    let body: unknown
    try {
      const res = await this.getJson(
        `${this.base}/v1/data?generation=${gen}&cursor=${requested}&limit=${PAGE_LIMIT}`,
        token,
      )
      code = res.status
      body = res.body
    } catch (err) {
      this.fail(token, `GUI 数据拉取失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!this.alive(token)) return
    if (code === 409) {
      this.fail(token, 'GUI 数据游标过期或采集已重启（409），已停止；请重新连接。')
      return
    }
    if (code !== 200) {
      this.fail(token, `GUI /v1/data 返回 HTTP ${code}`)
      return
    }
    let page: GuiDataPage
    try {
      page = decodeGuiDataPage(body)
      if (page.generation !== gen) throw new Error(`generation 已变化（${page.generation}≠${gen}）`)
      if (page.nextCursor !== requested + page.batch.samples) {
        throw new Error(`游标不连续（next_cursor ${page.nextCursor}≠${requested}+${page.batch.samples}）`)
      }
      if (this.channelKey && (page.batch.channelNames.join('|') !== this.channelKey || page.batch.sampleRate !== this.sampleRate)) {
        throw new Error('GUI 通道布局或采样率在会话中变化，已停止以避免混排数据')
      }
    } catch (err) {
      this.fail(token, `GUI 数据页校验失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const batch = page.batch
    if (batch.samples > 0) {
      // Client-observed missing sequence positions since the bootstrap baseline
      // (uint32 wrap aware); independent of the GUI-global sequence_lost counter.
      let missing = 0
      for (const seq of batch.sequence) {
        if (this.lastSeq !== null) {
          const delta = (seq - this.lastSeq) >>> 0
          if (delta > 1 && delta < 0x80000000) missing += delta - 1
        }
        this.lastSeq = seq
      }
      this.packetLoss += missing
      this.packetCount += 1
      const out: OmniDataBatch = {
        ...batch,
        sessionId: `gui-${this.sessionId}:${gen}`,
        packetCount: this.packetCount,
        packetLoss: this.packetLoss,
      }
      this.opts.onBatch?.(out)
    }
    this.cursor = page.nextCursor
    // Catch up immediately while buffered rows remain; idle poll otherwise.
    this.scheduleData(token, page.nextCursor < page.endCursor ? 0 : DATA_IDLE_MS)
  }
}
