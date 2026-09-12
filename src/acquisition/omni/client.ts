/** Browser client for OmniBCI V19 localhost API (`ws://127.0.0.1:8765`). */

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
    this.opts.onStatus?.('connecting', '正在连接 OmniBCI V19 本机 API…')
    this.connectTimer = setTimeout(() => {
      if (this.helloReceived || this.closedByUser) return
      this.opts.onStatus?.(
        'error',
        '连接超时。请先打开 OmniBCI V19，并在应用里开始测量。',
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
      ws.send(JSON.stringify({ type: 'subscribe', stream: this.opts.stream }))
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleText(ev.data)
        return
      }
      if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data)
    }

    ws.onerror = () => {
      if (!this.closedByUser) {
        this.clearConnectTimer()
        this.opts.onStatus?.(
          'error',
          '无法连接 OmniBCI V19（ws://127.0.0.1:8765）。请先打开 OmniBCI 应用。',
        )
      }
    }

    ws.onclose = () => {
      this.clearConnectTimer()
      this.ws = null
      this.pendingHeader = null
      if (!this.closedByUser) this.opts.onStatus?.('closed', 'OmniBCI 连接已断开')
    }
  }

  disconnect(): void {
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

  private handleText(text: string): void {
    const parsed = parseOmniText(text, this.opts.stream)
    if (parsed.kind === 'error') {
      this.fail(parsed.message)
      return
    }
    if (parsed.kind === 'hello') {
      this.helloReceived = true
      this.clearConnectTimer()
      this.opts.onHello?.(parsed.hello)
      const n = parsed.hello.channels.length
      this.opts.onStatus?.(
        'live',
        `已连接 OmniBCI V19 · ${n} 通道 @ ${parsed.hello.sample_rate} Hz（${parsed.hello.stream}）`,
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

  private handleBinary(buf: ArrayBuffer): void {
    const header = this.pendingHeader
    this.pendingHeader = null
    if (!header) return
    const decoded = decodeOmniDataBatch(header, buf, this.opts.stream)
    if ('error' in decoded) {
      this.opts.onStatus?.('error', decoded.error)
      return
    }
    this.opts.onBatch?.(decoded)
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
  opts?: { sequence?: number; url?: string },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(number) || number < 1 || number > 255) {
    return Promise.reject(new Error('trigger 必须是 1–255 的整数'))
  }
  return omniControlRequest(
    {
      type: 'marker',
      code: 'soft_trigger',
      value: number,
      sequence: opts?.sequence ?? null,
      duration: 0,
      description: '',
    },
    { url: opts?.url },
  )
}
