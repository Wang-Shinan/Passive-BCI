import { BcigoWsClient, type BcigoHello, type BcigoStatus } from '../../acquisition/bcigo/client'
import { ensureBridge } from '../../acquisition/bridgeApi'
import { acqRuntime, beginRawBridgeStream, ingestBridgeToHub } from '../../acquisition/runtime'
import { liveEegHub } from '../../lib/eeg/liveHub'

function bcigoUrl(): string {
  if (typeof window === 'undefined' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'ws://127.0.0.1:8767/v1/stream'
  }
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/bcigo`
}

/** Attach this browser tab to BCIGo. A bridge process alone does not deliver EEG to a new tab. */
let pending: Promise<void> | null = null

export function ensureGridBcigoStream(signal?: AbortSignal): Promise<void> {
  if (acqRuntime.streaming && acqRuntime.device === 'bcigo' && acqRuntime.bcigo && liveEegHub.isFresh()) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
  // The physical stream is shared. A React StrictMode cleanup from one caller
  // must not cancel the connection another caller is already awaiting.
  if (!pending) pending = connectGridBcigoStream().finally(() => { pending = null })
  return pending.then(() => {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  })
}

async function connectGridBcigoStream(): Promise<void> {
  await ensureBridge('bcigo')
  acqRuntime.bcigo?.disconnect()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    const fail = (message?: string) => {
      acqRuntime.streaming = false
      acqRuntime.status = 'error'
      liveEegHub.markError(message)
      finish(new Error(message || 'BCIGo 数据流连接失败'))
    }
    const status = (value: BcigoStatus, detail?: string) => {
      if (value === 'error' || value === 'closed') fail(detail)
      else if (value === 'connecting') {
        acqRuntime.status = 'connecting'
        liveEegHub.markConnecting(detail)
      }
    }
    const hello = (value: BcigoHello) => {
      beginRawBridgeStream()
      acqRuntime.device = 'bcigo'
      acqRuntime.streaming = true
      acqRuntime.status = 'streaming'
      liveEegHub.configure({ device: 'bcigo', sampleRate: value.sample_rate, channelNames: value.channels,
        detail: `棋盘已直接接入 BCIGo · ${value.channels.length} 导 @ ${value.sample_rate} Hz` })
      liveEegHub.markStreaming()
      finish()
    }
    const client = new BcigoWsClient({ url: bcigoUrl(), sampleRate: 250, gain: 6, signal: 'normal',
      onStatus: status, onHello: hello, onBatch: ingestBridgeToHub, onError: fail })
    acqRuntime.device = 'bcigo'
    acqRuntime.bcigo = client
    client.connect()
  })
}
