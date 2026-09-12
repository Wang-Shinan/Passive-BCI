/** Module-level acquisition session so device links survive SPA route changes. */

import { liveEegHub } from '../lib/eeg/liveHub'
import { sampleClock } from '../lib/eeg/sampleClock'
import { LiveIirFilter } from './filter/iir'
import { CHANNELS, FRAME_BYTES, FS, channelLsbUv, defaultChannelConfig } from './protocol/constants'
import { ConfigAckScanner, type ConfigAck } from './protocol/configAck'
import { AdsFrameParser } from './protocol/frameParser'
import { BinRecorder } from './session/recorder'
import { WebSerialTransport, type SerialStatus } from './transport/webSerial'
import type { BcigoWsClient } from './bcigo/client'
import type { NeuracleWsClient } from './neuracle/client'
import type { OmniWsClient } from './omni/client'
import {
  INGEST_DRAIN_BUDGET_MS,
  BRIDGE_DRAIN_BUDGET_MS,
  addPendingSamples,
  addQueuedBytes,
  noteLiveSamples,
  setCatchupClock,
} from './liveCatchup'

export type DeviceKind = 'omni' | 'neuracle' | 'bcigo'
export type OmniLink = 'usb' | 'api'
export type ConnUi = 'idle' | 'connecting' | 'open' | 'streaming' | 'error' | 'unsupported' | 'demo'

export type BridgeBatch = {
  values: Float32Array
  samples: number
  channels: number
  sampleRate: number
  channelNames: string[]
  unit: string
  packetLoss: number
  packetCount: number
  arrivalNowMs?: number
  deviceEndMs?: number
  deviceStartMs?: number
  deviceTotalSamples?: number
  sequence?: Uint32Array
  validFlags?: Uint8Array
  droppedSamples?: number
}

export type RawBridgeBatch = BridgeBatch & {
  device: DeviceKind
  streamId: number
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
  omni: null as OmniWsClient | null,
  omniLink: 'api' as OmniLink,
  streaming: false,
  lsb: channelLsbUv(defaultChannelConfig().gains),
  device: 'omni' as DeviceKind,
  status: 'idle' as ConnUi,
  ui: null as AcquisitionUiSink | null,
  /** ADS1299 AC lead-off in progress: stream for Z, never mix into BIN / live EEG hub. */
  impedanceActive: false,
}

const ackScanner = new ConfigAckScanner()
const rawBridgeListeners = new Set<(batch: RawBridgeBatch) => void>()
let rawBridgeStreamId = 0
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

function copyBytes(chunk: Uint8Array): Uint8Array {
  const out = new Uint8Array(chunk.byteLength)
  out.set(chunk)
  return out
}

const serialQ: Uint8Array[] = []
const bridgeQ: BridgeBatch[] = []
let draining = false

function scheduleDrain(): void {
  if (draining) return
  draining = true
  queueMicrotask(drainIngest)
}

function drainIngest(): void {
  const budget =
    bridgeQ.length > 2 ? BRIDGE_DRAIN_BUDGET_MS : INGEST_DRAIN_BUDGET_MS
  const deadline = performance.now() + budget
  while (performance.now() < deadline) {
    if (serialQ.length) {
      const chunk = serialQ.shift()!
      addQueuedBytes(-chunk.byteLength)
      deliverSerial(chunk)
      continue
    }
    if (bridgeQ.length) {
      const batch = bridgeQ.shift()!
      addPendingSamples(-batch.samples)
      deliverBridge(batch)
      continue
    }
    break
  }
  if (serialQ.length || bridgeQ.length) {
    setTimeout(() => {
      draining = false
      scheduleDrain()
    }, 0)
    return
  }
  draining = false
}

function deliverSerial(chunk: Uint8Array): void {
  const rest = takeSerialChunk(chunk)
  if (!rest.byteLength) return
  if (acqRuntime.ui) {
    acqRuntime.ui.onSerialData(rest)
    return
  }
  if (!acqRuntime.streaming) return
  const frames = acqRuntime.parser?.feed(rest) ?? []
  for (const f of frames) {
    acqRuntime.filter.processSample(f.uv, f.valid)
    if (!acqRuntime.impedanceActive) liveEegHub.pushFrame(f.uv)
    if (acqRuntime.recorder.recording && !acqRuntime.impedanceActive) {
      acqRuntime.recorder.append(f.raw)
    }
  }
  if (frames.length) {
    noteLiveSamples(frames.length)
    sampleClock.noteBatch({
      samples: frames.length,
      sampleRate: FS,
      arrivalNowMs: performance.now(),
    })
  }
}

function deliverBridge(batch: BridgeBatch): void {
  if (acqRuntime.streaming && !acqRuntime.impedanceActive && batch.samples > 0) {
    noteLiveSamples(batch.samples)
    sampleClock.noteBatch({
      samples: batch.samples,
      sampleRate: batch.sampleRate,
      arrivalNowMs: batch.arrivalNowMs ?? performance.now(),
      deviceEndMs: batch.deviceEndMs,
    })
  }
  if (
    acqRuntime.streaming &&
    !acqRuntime.impedanceActive &&
    batch.values.length === batch.samples * batch.channels
  ) {
    const rawBatch: RawBridgeBatch = {
      ...batch,
      device: acqRuntime.device,
      streamId: rawBridgeStreamId,
    }
    for (const listener of rawBridgeListeners) {
      try {
        listener(rawBatch)
      } catch (error) {
        console.error('[model-runtime] raw batch listener failed', error)
      }
    }
  }
  if (acqRuntime.ui) {
    acqRuntime.ui.onBridgeBatch(batch)
    return
  }
  if (!acqRuntime.streaming) return
  if (!acqRuntime.impedanceActive) {
    liveEegHub.pushInterleaved(batch.values, batch.samples, batch.channels)
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

/** Bridge batches while the acquisition page is unmounted. */
export function ingestBridgeToHub(batch: BridgeBatch): void {
  liveEegHub.noteArrival()
  bridgeQ.push(batch)
  addPendingSamples(batch.samples)
  scheduleDrain()
}

/** Observe raw bridge batches without coupling model work to the display ring. */
export function subscribeRawBridgeBatches(
  listener: (batch: RawBridgeBatch) => void,
): () => void {
  rawBridgeListeners.add(listener)
  return () => rawBridgeListeners.delete(listener)
}

/** Start a new continuity segment before accepting bridge samples. */
export function beginRawBridgeStream(): void {
  rawBridgeStreamId += 1
}

function ingestSerialToHub(chunk: Uint8Array): void {
  liveEegHub.noteArrival()
  const copy = copyBytes(chunk)
  serialQ.push(copy)
  addQueuedBytes(copy.byteLength)
  scheduleDrain()
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
  setCatchupClock(FS, FRAME_BYTES)
  acqRuntime.transport.setHandlers({
    onData: ingestSerialToHub,
    onStatus: onSerialStatus,
  })
}

export function setAcquisitionUi(ui: AcquisitionUiSink | null): void {
  acqRuntime.ui = ui
  bindPersistentTransport()
}

export function omniUsesApi(): boolean {
  return acqRuntime.device === 'omni' && acqRuntime.omniLink === 'api'
}

export function omniRecordsAsFrames(): boolean {
  return acqRuntime.device === 'omni' && acqRuntime.omniLink === 'usb'
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
