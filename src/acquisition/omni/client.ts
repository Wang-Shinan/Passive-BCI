/** Browser client for native OmniBCI WebSocket or the LSL bridge. */
import { lslClock } from '../../lib/eeg/lslClock'
import { captureSystemClock, type SystemClockStamp } from '../../lib/eeg/systemClock'
import { decodeNativeEeg, sendNativeTrigger, type TriggerAck } from './native'

import {
  OMNI_API_PORT,
  OMNI_API_SCHEMA,
  OMNI_STREAM_RAW,
  decodeOmniDataBatch,
  parseOmniText,
  type OmniDataBatch,
  type OmniGapEvent,
  type OmniHello,
  type OmniMarkerEvent,
  type OmniStreamKind,
} from './protocol'

export {
  OMNI_API_PORT,
  OMNI_API_SCHEMA,
  OMNI_CHANNEL_NAMES,
  OMNI_CHANNELS,
  OMNI_SAMPLE_RATE,
  OMNI_STREAM_FILTERED,
  OMNI_STREAM_RAW,
} from './protocol'
export type { OmniDataBatch, OmniGapEvent, OmniHello, OmniMarkerEvent, OmniStreamKind }

export type OmniStatus = 'idle' | 'connecting' | 'live' | 'error' | 'closed'

export interface OmniClientOptions {
  native?: boolean
  url?: string
  stream?: OmniStreamKind
  onStatus?: (status: OmniStatus, detail?: string) => void
  onHello?: (hello: OmniHello) => void
  onBatch?: (batch: OmniDataBatch) => void
  onGap?: (gap: OmniGapEvent) => void
  onMarker?: (marker: OmniMarkerEvent) => void
  onError?: (message: string) => void
}

export function omniStreamUrl(port = OMNI_API_PORT): string {
  return `ws://127.0.0.1:${port}/v1/stream`
}

export function omniControlUrl(streamUrl: string): string {
  try {
    const url = new URL(streamUrl)
    url.pathname = '/v1/control'
    return url.toString()
  } catch {
    return `ws://127.0.0.1:${OMNI_API_PORT}/v1/control`
  }
}

export class OmniWsClient {
  private ws: WebSocket | null = null
  private pendingHeader: Record<string, unknown> | null = null
  private closedByUser = false
  private helloReceived = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private clockRequests = new Set<number>()
  private readonly opts: OmniClientOptions & { url: string; stream: OmniStreamKind }

  constructor(opts: OmniClientOptions = {}) {
    this.opts = {
      url: opts.url ?? omniStreamUrl(),
      stream: opts.stream ?? OMNI_STREAM_RAW,
      ...opts,
    }
  }

  connect(): void {
    this.disconnect()
    this.closedByUser = false
    this.helloReceived = false
    this.pendingHeader = null
    const transport = this.opts.native ? '原生 WebSocket' : 'LSL 桥接'
    this.opts.onStatus?.('connecting', `正在连接 OmniBCI ${transport}（${this.opts.url}）…`)
    this.connectTimer = setTimeout(() => {
      if (this.helloReceived || this.closedByUser) return
      this.opts.onStatus?.(
        'error',
        this.opts.native ? '未收到 EEG：请开始采集并启用 Web API / Trigger 和 WebSocket 实时转发。' : '连接超时。请先在 OmniBCI 中开始测量并启用 LSL。',
      )
      this.disconnect()
    }, 8_000)

    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch (err) {
      this.clearConnectTimer()
      const msg = err instanceof Error ? err.message : String(err)
      this.opts.onStatus?.('error', msg)
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      if (!this.opts.native) ws.send(JSON.stringify({ type: 'subscribe', stream: this.opts.stream }))
    }

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      const receivedClock = captureSystemClock()
      if (typeof ev.data === 'string') {
        this.handleText(ev.data, receivedClock)
        return
      }
      if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data, receivedClock)
    }

    ws.onerror = () => {
      if (this.ws === ws && !this.closedByUser) {
        this.fail(`OmniBCI ${transport}连接失败（${this.opts.url}）。${this.opts.native ? '请检查应用的 WebSocket 实时转发是否启用，地址及端口是否正确。' : '请检查 LSL 桥接服务和 EEG 流。'}`)
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.clearClock()
      this.clearConnectTimer()
      this.ws = null
      this.pendingHeader = null
      if (!this.closedByUser) this.opts.onStatus?.(
        this.helloReceived ? 'closed' : 'error',
        this.helloReceived ? `OmniBCI ${transport}连接已断开` : `OmniBCI ${transport}在收到 EEG 数据前关闭（${this.opts.url}）。`,
      )
    }
  }

  disconnect(): void {
    this.clearClock()
    this.closedByUser = true
    this.clearConnectTimer()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.pendingHeader = null
  }

  private clearConnectTimer(): void {
    if (this.connectTimer != null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private fail(message: string): void {
    this.clearConnectTimer()
    this.opts.onError?.(message)
    this.opts.onStatus?.('error', message)
    this.disconnect()
  }

  private handleText(text: string, receivedClock: SystemClockStamp): void {
    if (this.opts.native) {
      try {
        const batch = decodeNativeEeg(text)
        batch.receivedClock = receivedClock
        if (!this.helloReceived) {
          this.helloReceived = true
          this.clearConnectTimer()
          this.opts.onHello?.({ type: 'hello', schema_version: OMNI_API_SCHEMA, stream: 'raw',
            sample_rate: batch.sampleRate, channels: batch.channelNames, unit: 'uV' })
          this.opts.onStatus?.('live', `已直连 OmniBCI · ${batch.channels} 通道 @ ${batch.sampleRate} Hz`)
        }
        this.opts.onBatch?.(batch)
      } catch (error) { this.fail(error instanceof Error ? error.message : String(error)) }
      return
    }
    try {
      const msg = JSON.parse(text)
      if (msg.type === 'clock_pong') {
        if (this.clockRequests.delete(msg.browser_ms)) lslClock.observe(msg.browser_ms, performance.now(), msg.receive_sec, msg.send_sec)
        return
      }
    } catch { /* The protocol parser reports malformed messages. */ }
    const parsed = parseOmniText(text, this.opts.stream)
    if (parsed.kind === 'error') {
      this.fail(parsed.message)
      return
    }
    if (parsed.kind === 'hello') {
      const ping = () => {
        if (this.ws?.readyState !== WebSocket.OPEN) return
        const now = performance.now()
        this.clockRequests = new Set([...this.clockRequests].filter(t => now - t < 30000))
        this.clockRequests.add(now)
        this.ws.send(JSON.stringify({ type: 'clock_ping', browser_ms: now }))
      }
      this.clearClock()
      ping()
      this.clockTimer = setInterval(ping, 2000)
      this.helloReceived = true
      this.clearConnectTimer()
      this.opts.onHello?.(parsed.hello)
      const n = parsed.hello.channels.length
      this.opts.onStatus?.(
        'live',
        `已连接 OmniBCI LSL · ${n} 通道 @ ${parsed.hello.sample_rate} Hz（${parsed.hello.stream}）`,
      )
      return
    }
    if (parsed.kind === 'gap') {
      this.opts.onGap?.(parsed.gap)
      return
    }
    if (parsed.kind === 'marker') {
      this.opts.onMarker?.(parsed.marker)
      return
    }
    this.pendingHeader = parsed.header
  }

  private handleBinary(buf: ArrayBuffer, receivedClock: SystemClockStamp): void {
    const header = this.pendingHeader
    this.pendingHeader = null
    if (!header) return
    const decoded = decodeOmniDataBatch(header, buf, this.opts.stream)
    if ('error' in decoded) {
      this.opts.onStatus?.('error', decoded.error)
      return
    }
    this.opts.onBatch?.({ ...decoded, receivedClock })
  }

  private clearClock(): void {
    if (this.clockTimer !== null) clearInterval(this.clockTimer)
    this.clockTimer = null
    this.clockRequests.clear()
    lslClock.reset()
  }
}

export type OmniControlResult = {
  ok: true
  result: Record<string, unknown>
}

export async function omniControlRequest(
  request: Record<string, unknown>,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const url = opts.url ?? omniControlUrl(omniStreamUrl())
  const timeoutMs = opts.timeoutMs ?? 5000
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const payload = { ...request, request_id: requestId }

  return new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      fail(new Error('OmniBCI 控制请求超时'))
    }, timeoutMs)

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(err)
    }

    ws.onerror = () => fail(new Error('无法连接 OmniBCI 控制通道'))
    ws.onopen = () => {
      ws.send(JSON.stringify(payload))
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        fail(new Error('OmniBCI 控制响应必须是 JSON'))
        return
      }
      let response: Record<string, unknown>
      try {
        response = JSON.parse(ev.data) as Record<string, unknown>
      } catch {
        fail(new Error('OmniBCI 控制响应不是合法 JSON'))
        return
      }
      if (
        response.type !== 'control_response' ||
        response.schema_version !== OMNI_API_SCHEMA ||
        response.request_id !== requestId
      ) {
        fail(new Error('OmniBCI 控制响应无效'))
        return
      }
      if (!response.ok) {
        const error = (response.error ?? {}) as Record<string, unknown>
        fail(
          new Error(
            `OmniBCI 控制错误 ${String(error.code ?? 'unknown')}: ${String(error.message ?? 'failed')}`,
          ),
        )
        return
      }
      const result = isRecord(response.result) ? response.result : {}
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sendOmniTrigger(
  number: number,
  opts?: { label?: string },
): Promise<TriggerAck> {
  return sendNativeTrigger(number, opts?.label ?? '')
}
