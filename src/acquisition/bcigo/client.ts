/** Browser client for bridges/bcigo/ws_bridge.py (BrainCo / 强脑) */

export const BCIGO_CHANNEL_NAMES = [
  'FP1', 'FP2', 'F3', 'F4', 'F7', 'F8', 'Fz',
  'C3', 'C4', 'Cz',
  'P3', 'P4', 'P7', 'P8', 'Pz',
  'O1', 'O2',
  'T7', 'T8',
  'FC1', 'FC2', 'FC5', 'FC6',
  'CP1', 'CP2', 'CP5', 'CP6',
  'FT9', 'FT10',
  'TP9', 'TP10',
  'IO',
] as const

export type BcigoStatus = 'idle' | 'connecting' | 'live' | 'error' | 'closed'

export interface BcigoHello {
  type: 'hello'
  schema_version: number
  device: string
  sample_rate: number
  channels: string[]
  channel_types: string[]
  module: string
  unit: string
  host: string
  port: number
  forwarded_channels: number
  gain?: number
  signal?: string
  data_ready?: boolean
  supports_impedance?: boolean
}

export interface BcigoBatch {
  values: Float32Array
  samples: number
  channels: number
  sampleRate: number
  channelNames: string[]
  unit: string
  packetLoss: number
  packetCount: number
}

export interface BcigoImpedance {
  channels: string[]
  valuesKohm: (number | null)[]
  packetCount: number
}

export interface BcigoClientOptions {
  url?: string
  /** Empty → bridge mDNS discovery */
  host?: string
  port?: number | null
  sampleRate?: number
  gain?: number
  signal?: 'normal' | 'test' | 'shorted' | 'mvdd' | string
  msgType?: string
  nChannels?: number
  onStatus?: (status: BcigoStatus, detail?: string) => void
  onHello?: (hello: BcigoHello) => void
  onBatch?: (batch: BcigoBatch) => void
  onImpedance?: (imp: BcigoImpedance) => void
  onImpedanceStatus?: (active: boolean, message?: string) => void
  onError?: (message: string) => void
}

export class BcigoWsClient {
  private ws: WebSocket | null = null
  private pendingHeader: Record<string, unknown> | null = null
  private closedByUser = false
  private helloReceived = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly opts: BcigoClientOptions & { url: string }

  constructor(opts: BcigoClientOptions = {}) {
    this.opts = {
      url: opts.url ?? 'ws://127.0.0.1:8767/v1/stream',
      ...opts,
    }
  }

  connect(): void {
    this.disconnect()
    this.closedByUser = false
    this.helloReceived = false
    this.pendingHeader = null
    this.opts.onStatus?.('connecting')
    this.connectTimer = setTimeout(() => {
      if (this.helloReceived || this.closedByUser) return
      this.opts.onStatus?.(
        'error',
        '连接超时。请关闭强脑官方 App，确认设备在同一 Wi‑Fi，然后重试。',
      )
      this.disconnect()
    }, 25_000)

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
      const payload: Record<string, unknown> = {
        type: 'subscribe',
        sample_rate: this.opts.sampleRate ?? 250,
        gain: this.opts.gain ?? 6,
        signal: this.opts.signal ?? 'normal',
        msg_type: this.opts.msgType ?? 'BCIGo',
        n_channels: this.opts.nChannels ?? 32,
      }
      const host = (this.opts.host ?? '').trim()
      if (host) payload.host = host
      if (this.opts.port != null && Number(this.opts.port) > 0) {
        payload.port = Number(this.opts.port)
      }
      ws.send(JSON.stringify(payload))
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
          '无法连接强脑 BCIGo 桥接。请确认 npm run dev 已启动（会自动拉桥）。',
        )
      }
    }

    ws.onclose = () => {
      this.clearConnectTimer()
      this.ws = null
      this.pendingHeader = null
      // User/timeout disconnect: leave whatever status the caller already set
      // (error / idle). Only report unexpected drops.
      if (!this.closedByUser) this.opts.onStatus?.('closed', '连接已断开')
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

  startImpedance(): void {
    this.send({ type: 'impedance_start' })
  }

  stopImpedance(): void {
    this.send({ type: 'impedance_stop' })
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.opts.onError?.('桥接未连接，无法发送命令')
      return
    }
    this.ws.send(JSON.stringify(payload))
  }

  private handleText(text: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text) as Record<string, unknown>
    } catch {
      this.opts.onStatus?.('error', '非法 JSON')
      this.disconnect()
      return
    }
    if (msg.type === 'hello') {
      this.helloReceived = true
      this.clearConnectTimer()
      this.opts.onHello?.(msg as unknown as BcigoHello)
      const ch = Array.isArray(msg.channels) ? msg.channels.length : '?'
      const host = String(msg.host ?? '')
      const port = String(msg.port ?? '')
      this.opts.onStatus?.(
        'live',
        `已连接 ${(msg.module as string) || 'BCIGo'} · ${ch} 通道 @ ${host}:${port}`,
      )
      return
    }
    if (msg.type === 'status') {
      const message = String(msg.message ?? '')
      if (!message) return
      // Before hello, keep UI on "connecting"; only refresh the detail text.
      if (this.helloReceived) this.opts.onStatus?.('live', message)
      else this.opts.onStatus?.('connecting', message)
      return
    }
    if (msg.type === 'impedance_status') {
      this.opts.onImpedanceStatus?.(Boolean(msg.active), String(msg.message ?? ''))
      return
    }
    if (msg.type === 'impedance') {
      const values = Array.isArray(msg.values_kohm)
        ? (msg.values_kohm as (number | null)[])
        : []
      this.opts.onImpedance?.({
        channels: Array.isArray(msg.channels) ? (msg.channels as string[]) : [],
        valuesKohm: values,
        packetCount: Number(msg.packet_count) || 0,
      })
      return
    }
    if (msg.type === 'error') {
      this.clearConnectTimer()
      const message = String(msg.message ?? 'unknown')
      this.opts.onError?.(message)
      this.opts.onStatus?.('error', message)
      return
    }
    if (msg.type === 'data') {
      this.pendingHeader = msg
      return
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    const header = this.pendingHeader
    this.pendingHeader = null
    if (!header) return
    const shape = header.shape as [number, number] | undefined
    if (!shape || shape.length !== 2) return
    const [samples, channels] = shape
    const expected = samples * channels * 4
    if (buf.byteLength !== expected) {
      this.opts.onStatus?.('error', `payload 长度不匹配 ${buf.byteLength}≠${expected}`)
      return
    }
    const values = new Float32Array(buf.slice(0))
    this.opts.onBatch?.({
      values,
      samples,
      channels,
      sampleRate: Number(header.sample_rate) || 250,
      channelNames: Array.isArray(header.channels)
        ? (header.channels as string[])
        : [],
      unit: String(header.unit ?? 'uV'),
      packetLoss: Number(header.packet_loss_count) || 0,
      packetCount: Number(header.packet_count) || 0,
    })
  }
}
