/** Module-level acquisition session so device links survive SPA route changes. */

import { liveEegHub } from '../lib/eeg/liveHub'
import { LiveIirFilter } from './filter/iir'
import { CHANNELS, channelLsbUv, defaultChannelConfig } from './protocol/constants'
import { ConfigAckScanner, type ConfigAck } from './protocol/configAck'
import { AdsFrameParser } from './protocol/frameParser'
import { BinRecorder } from './session/recorder'
import { WebSerialTransport, type SerialStatus } from './transport/webSerial'
import type { BcigoWsClient } from './bcigo/client'
import type { NeuracleWsClient } from './neuracle/client'

export type DeviceKind = 'omni' | 'neuracle' | 'bcigo'
export type ConnUi = 'idle' | 'connecting' | 'open' | 'streaming' | 'error' | 'unsupported' | 'demo'

export type BridgeBatch = {
  values: Float32Array
  samples: number
  channels: number
  packetLoss: number
  packetCount: number
}

export type AcquisitionUiSink = {
  onSerialData: (chunk: Uint8Array) => void
  onSerialStatus: (s: SerialStatus, detail?: string) => void
  onBridgeBatch: (batch: BridgeBatch) => void
}

export const acqRuntime = {
  transport: new WebSerialTransport(),
  parser: null as AdsFrameParser | null,
  filter: new LiveIirFilter(CHANNELS),
  recorder: new BinRecorder(),
  neuracle: null as NeuracleWsClient | null,
  bcigo: null as BcigoWsClient | null,
  streaming: false,
  lsb: channelLsbUv(defaultChannelConfig().gains),
  device: 'omni' as DeviceKind,
  status: 'idle' as ConnUi,
  ui: null as AcquisitionUiSink | null,
  /** ADS1299 AC lead-off in progress: stream for Z, never mix into BIN / live EEG hub. */
  impedanceActive: false,
}

const ackScanner = new ConfigAckScanner()
let ackWaiter: {
  resolve: (ack: ConfigAck | null) => void
  timer: ReturnType<typeof setTimeout>
} | null = null

function takeSerialChunk(chunk: Uint8Array): Uint8Array {
  if (ackScanner.expectedCmd == null) return chunk
  const { leftover, ack } = ackScanner.feed(chunk)
  if (ack && ackWaiter) {
    clearTimeout(ackWaiter.timer)
    const resolve = ackWaiter.resolve
    ackWaiter = null
    resolve(ack)
  }
  return leftover
}

/** Read firmware 12-byte config ACK (`0xBC` + command). Drops EEG bytes while waiting. */
export function waitConfigAck(expectedCmd: number, timeoutMs = 1200): Promise<ConfigAck | null> {
  if (ackWaiter) {
    clearTimeout(ackWaiter.timer)
    ackWaiter.resolve(null)
    ackWaiter = null
  }
  ackScanner.begin(expectedCmd)
  return new Promise((resolve) => {
    ackWaiter = {
      resolve,
      timer: setTimeout(() => {
        ackScanner.clear()
        ackWaiter = null
        resolve(null)
      }, timeoutMs),
    }
  })
}

export function cancelConfigAckWait(): void {
  if (ackWaiter) {
    clearTimeout(ackWaiter.timer)
    ackWaiter.resolve(null)
    ackWaiter = null
  }
  ackScanner.clear()
}

function hubPushFiltered(raw: Float32Array): void {
  if (acqRuntime.impedanceActive) return
  if (raw.length) acqRuntime.filter.setChannelCount(raw.length)
  const filtered = acqRuntime.filter.processSample(raw, true)
  liveEegHub.pushFrame(filtered)
}

/** Bridge batches while the acquisition page is unmounted. */
export function ingestBridgeToHub(batch: BridgeBatch): void {
  if (acqRuntime.ui) {
    acqRuntime.ui.onBridgeBatch(batch)
    return
  }
  if (!acqRuntime.streaming) return
  const n = batch.channels
  for (let s = 0; s < batch.samples; s++) {
    hubPushFiltered(batch.values.subarray(s * n, s * n + n))
  }
  if (acqRuntime.recorder.recording && !acqRuntime.impedanceActive) {
    const bytes = new Uint8Array(
      batch.values.buffer,
      batch.values.byteOffset,
      batch.values.byteLength,
    )
    acqRuntime.recorder.append(bytes)
  }
}

function ingestSerialToHub(chunk: Uint8Array): void {
  const rest = takeSerialChunk(chunk)
  if (!rest.byteLength) return
  if (acqRuntime.ui) {
    acqRuntime.ui.onSerialData(rest)
    return
  }
  if (!acqRuntime.streaming) return
  const frames = acqRuntime.parser?.feed(rest) ?? []
  for (const f of frames) {
    const filtered = acqRuntime.filter.processSample(f.uv, f.valid)
    if (!acqRuntime.impedanceActive) liveEegHub.pushFrame(filtered)
    if (acqRuntime.recorder.recording && !acqRuntime.impedanceActive) {
      acqRuntime.recorder.append(f.raw)
    }
  }
}

function onSerialStatus(s: SerialStatus, detail?: string): void {
  if (acqRuntime.ui) {
    acqRuntime.ui.onSerialStatus(s, detail)
    return
  }
  if (s === 'error') {
    acqRuntime.streaming = false
    acqRuntime.status = 'error'
    liveEegHub.markError(detail)
  } else if (s === 'idle') {
    acqRuntime.streaming = false
    acqRuntime.status = 'idle'
    liveEegHub.markIdle(detail)
  }
}

export function bindPersistentTransport(): void {
  if (!acqRuntime.parser) {
    acqRuntime.parser = new AdsFrameParser(() => acqRuntime.lsb)
  }
  acqRuntime.transport.setHandlers({
    onData: ingestSerialToHub,
    onStatus: onSerialStatus,
  })
}

export function setAcquisitionUi(ui: AcquisitionUiSink | null): void {
  acqRuntime.ui = ui
  bindPersistentTransport()
}

export function syncHubLinkFromStatus(status: ConnUi, detail?: string): void {
  acqRuntime.status = status
  if (status === 'connecting') liveEegHub.markConnecting(detail)
  else if (status === 'open') liveEegHub.markOpen(detail)
  else if (status === 'streaming' || status === 'demo') {
    if (status === 'demo') liveEegHub.configure({ device: 'demo' })
    liveEegHub.markStreaming(detail)
  } else if (status === 'error') liveEegHub.markError(detail)
  else if (status === 'idle' || status === 'unsupported') {
    if (status === 'idle') liveEegHub.markIdle(detail)
  }
}
