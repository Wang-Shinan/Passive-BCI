/** Browser client for bridges/neuracle/ws_bridge.py */

export const NEURACLE_59_EEG_CHANNEL_NAMES = [
  'Fpz', 'Fp1', 'Fp2', 'AF3', 'AF4', 'AF7', 'AF8', 'Fz',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'FCz',
  'FC1', 'FC2', 'FC3', 'FC4', 'FC5', 'FC6', 'FT7', 'FT8',
  'Cz', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'T7', 'T8',
  'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6', 'TP7', 'TP8',
  'Pz', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'POz', 'PO3',
  'PO4', 'PO5', 'PO6', 'PO7', 'PO8', 'Oz', 'O1', 'O2',
] as const

export type NeuracleStatus = 'idle' | 'connecting' | 'live' | 'error' | 'closed'

export interface NeuracleHello {
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
}

export interface NeuracleBatch {
  values: Float32Array
  samples: number
  channels: number
  sampleRate: number
  channelNames: string[]
  packetLoss: number
  packetCount: number
}

export interface NeuracleClientOptions {
  url?: string
  host?: string
  port?: number
  sourceSfreq?: number
  /** null → all forwarded (≈64); named list → subset; [] → EEG-typed only */
  eegChannelNames?: string[] | null
  onStatus?: (status: NeuracleStatus, detail?: string) => void
  onHello?: (hello: NeuracleHello) => void
  onBatch?: (batch: NeuracleBatch) => void
  onError?: (message: string) => void
}

export class NeuracleWsClient {
  private ws: WebSocket | null = null
  private pendingHeader: Record<string, unknown> | null = null
  private closedByUser = false
  private readonly opts: NeuracleClientOptions & { url: string }

  constructor(opts: NeuracleClientOptions = {}) {
    this.opts = {
      url: opts.url ?? 'ws://127.0.0.1:8766/v1/stream',
      ...opts,
    }
  }

  connect(): void {
    this.disconnect()
    this.closedByUser = false
    this.pendingHeader = null
    this.opts.onStatus?.('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.opts.onStatus?.('error', msg)
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      const payload: Record<string, unknown> = {
        type: 'subscribe',
        host: this.opts.host ?? '127.0.0.1',
        port: this.opts.port ?? 8712,
        source_sfreq: this.opts.sourceSfreq ?? 250,
      }
      // null/undefined → all forwarded channels; [] kept for compatibility
      if (this.opts.eegChannelNames === null) {
        payload.eeg_channel_names = null
        payload.channel_mode = 'all_forwarded'
      } else if (Array.isArray(this.opts.eegChannelNames)) {
        payload.eeg_channel_names = this.opts.eegChannelNames
        payload.channel_mode =
          this.opts.eegChannelNames.length === 0 ? 'all_eeg' : 'named'
      } else {
        payload.channel_mode = 'all_forwarded'
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
        this.opts.onStatus?.(
          'error',
          '无法连接 Neuracle 桥接。请先运行：python bridges/neuracle/ws_bridge.py',
        )
      }
    }

    ws.onclose = () => {
      this.ws = null
      this.pendingHeader = null
      if (!this.closedByUser) this.opts.onStatus?.('closed', '连接已断开')
      else this.opts.onStatus?.('idle')
    }
  }

  disconnect(): void {
    this.closedByUser = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.pendingHeader = null
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
      this.opts.onHello?.(msg as unknown as NeuracleHello)
      this.opts.onStatus?.(
        'live',
        `已连接 ${(msg.module as string) || 'Neuracle'} · ${Array.isArray(msg.channels) ? msg.channels.length : '?'} 通道`,
      )
      return
    }
    if (msg.type === 'error') {
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
      packetLoss: Number(header.packet_loss_count) || 0,
      packetCount: Number(header.packet_count) || 0,
    })
  }
}
