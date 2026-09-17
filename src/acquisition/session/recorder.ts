import { sampleClock, type SampleClockDump } from '../../lib/eeg/sampleClock'
import { sessionHub } from '../../lib/session/sessionHub'
import { CONTEXT_SCHEMA, type SessionContextRecord } from '../../lib/session/contracts'
import type { LslTiming } from '../../lib/eeg/lslClock'
import type { NativeFrame } from '../omni/native'
import { captureSystemClock, type SystemClockStamp } from '../../lib/eeg/systemClock'

/** Stream EEG to disk (Vite /api/record) or coalesced memory as fallback. */

/** 64 ch × 4 B × 1000 Hz ≈ 256 KB/s; 32 KB ≈ 125 ms so live control is not stalled by 1 s dumps. */
export const RECORD_FLUSH_BYTES = 32 * 1024

export type RecordSinkKind = 'disk' | 'memory'

export interface RecordMeta {
  device?: string
  format?: string
  sampleRate?: number
  channels?: number
  channelNames?: string[]
  [key: string]: unknown
}

export interface RecordStartOptions {
  filenamePrefix: string
  meta?: RecordMeta
}

export interface RecordStopResult {
  bytes: number
  name: string
  sink: RecordSinkKind
  path?: string
  rel?: string
}

export type FirstDataReceived = {
  systemClock: SystemClockStamp
  capturePoint: 'transport_receive' | 'recorder_append'
  byteOffset: 0
}

export interface RecordFinishExtra {
  firstDataReceived?: FirstDataReceived | null
  clock?: SampleClockDump
  lslBatches?: SessionContextRecord[]
}

export interface RecordSink {
  kind: RecordSinkKind
  write(chunk: Uint8Array): Promise<void>
  finish(extra?: RecordFinishExtra): Promise<{ name: string; path?: string; rel?: string }>
  abort(): Promise<void>
}

export type CreateRecordSink = (opts: {
  filename: string
  meta?: RecordMeta
}) => Promise<RecordSink>

export function makeSessionId(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function recordFilename(prefix: string, sessionId = makeSessionId()): string {
  const p =
    prefix.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 64) || 'session'
  return `${p}_${sessionId}.bin`
}

export function formatRecordBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function triggerDownload(blob: Blob, name: string): void {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

class MemorySink implements RecordSink {
  readonly kind = 'memory' as const
  private chunks: Uint8Array[] = []
  private filename: string

  constructor(filename: string) {
    this.filename = filename
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk)
  }

  async finish(extra?: RecordFinishExtra): Promise<{ name: string }> {
    if (this.chunks.length) {
      triggerDownload(new Blob(this.chunks as BlobPart[], { type: 'application/octet-stream' }), this.filename)
    }
    if (extra?.clock && extra.clock.sampleIndex > 0) {
      triggerDownload(
        new Blob([`${JSON.stringify(extra.clock)}\n`], { type: 'application/json' }),
        this.filename.replace(/\.bin$/i, '.idx.json'),
      )
    }
    if (extra?.firstDataReceived) triggerDownload(new Blob([JSON.stringify({ firstDataReceived: extra.firstDataReceived })],
      { type: 'application/json' }), this.filename.replace(/\.bin$/i, '.timing.json'))
    this.chunks = []
    if (extra?.lslBatches?.length) triggerDownload(new Blob([extra.lslBatches.map(row => JSON.stringify(row)).join('\n') + '\n'],
      { type: 'application/x-ndjson' }), this.filename.replace(/\.bin$/i, '.lsl.jsonl'))
    return { name: this.filename }
  }

  async abort(): Promise<void> {
    this.chunks = []
  }
}

class DiskSink implements RecordSink {
  readonly kind = 'disk' as const
  private id: string
  private filename: string
  private path: string
  private rel: string

  constructor(id: string, filename: string, path: string, rel: string) {
    this.id = id
    this.filename = filename
    this.path = path
    this.rel = rel
  }

  static async open(filename: string, meta?: RecordMeta): Promise<DiskSink | null> {
    try {
      const res = await fetch('/api/record/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, meta: meta ?? null }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.warn(`[record] disk start failed (${res.status}) ${text}`)
        return null
      }
      const body = (await res.json()) as {
        ok?: boolean
        id?: string
        filename?: string
        path?: string
        dir?: string
        rel?: string
      }
      if (!body.ok || !body.id || !body.rel) {
        console.warn('[record] disk start returned an incomplete session', body)
        return null
      }
      const path = body.dir || body.path
      if (!path) return null
      sessionHub.attach({ id: body.id, rel: body.rel })
      return new DiskSink(body.id, body.filename || filename, path, body.rel)
    } catch (err) {
      console.warn('[record] disk start threw', err)
      return null
    }
  }

  async write(chunk: Uint8Array): Promise<void> {
    const body = new ArrayBuffer(chunk.byteLength)
    new Uint8Array(body).set(chunk)
    const res = await fetch(`/api/record/${this.id}/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    })
    if (!res.ok) throw new Error(`record chunk failed (${res.status})`)
  }

  async finish(extra?: RecordFinishExtra): Promise<{ name: string; path?: string; rel?: string }> {
    if (sessionHub.info.id === this.id) {
      await sessionHub.flush()
      sessionHub.detach()
    }
    const res = await fetch(`/api/record/${this.id}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(extra ?? {}),
    })
    if (!res.ok) throw new Error(`record finish failed (${res.status})`)
    const body = (await res.json()) as {
      path?: string | null
      dir?: string | null
      rel?: string | null
    }
    return {
      name: this.filename,
      path: body.dir || body.path || this.path,
      rel: body.rel || this.rel,
    }
  }

  async abort(): Promise<void> {
    if (sessionHub.info.id === this.id) sessionHub.discardAndDetach()
    try {
      await fetch(`/api/record/${this.id}/abort`, { method: 'POST' })
    } catch {
      /* ignore */
    }
  }
}

export class BinRecorder {
  private pending: Uint8Array
  private pendingLen = 0
  private bytes = 0
  private startedAt: number | null = null
  private sessionId = ''
  private filename = ''
  private sink: RecordSink | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private flushQueuedBytes = 0
  private readonly flushBytes: number
  private readonly createSink: CreateRecordSink | undefined
  private firstDataReceived: FirstDataReceived | null = null
  private lslBatches: SessionContextRecord[] = []

  constructor(opts?: { flushBytes?: number; createSink?: CreateRecordSink }) {
    this.flushBytes = opts?.flushBytes ?? RECORD_FLUSH_BYTES
    this.createSink = opts?.createSink
    this.pending = new Uint8Array(this.flushBytes)
  }

  get recording(): boolean {
    return this.startedAt !== null
  }

  get byteLength(): number {
    return this.bytes
  }

  get id(): string {
    return this.sessionId
  }

  get sinkKind(): RecordSinkKind | null {
    return this.sink?.kind ?? null
  }

  /** Bytes not yet acknowledged by the sink (fill buffer + in-flight flushes). */
  get pendingBytes(): number {
    return this.pendingLen + this.flushQueuedBytes
  }

  get inflightBytes(): number {
    return this.flushQueuedBytes
  }

  async start(opts: RecordStartOptions = { filenamePrefix: 'omni_ads1299' }): Promise<RecordSinkKind> {
    if (this.startedAt !== null) await this.discard()
    this.pending = new Uint8Array(this.flushBytes)
    this.pendingLen = 0
    this.bytes = 0
    this.lslBatches = []
    this.firstDataReceived = null
    this.flushQueuedBytes = 0
    this.flushChain = Promise.resolve()
    this.startedAt = Date.now()
    this.sessionId = makeSessionId()
    this.filename = recordFilename(opts.filenamePrefix, this.sessionId)
    if (this.createSink) {
      this.sink = await this.createSink({ filename: this.filename, meta: opts.meta })
    } else {
      this.sink =
        (await DiskSink.open(this.filename, opts.meta)) ?? new MemorySink(this.filename)
    }
    if (this.sink.kind === 'disk' && sessionHub.active && this.lslBatches.length) {
      for (const row of this.lslBatches) sessionHub.logContext(row)
      this.lslBatches = []
    }
    return this.sink.kind
  }

  append(frameRaw: Uint8Array, lsl?: LslTiming, nativeFrames?: NativeFrame[], receivedClock?: SystemClockStamp): void {
    if (this.startedAt === null || frameRaw.byteLength === 0) return
    if (!this.firstDataReceived) {
      const systemClock = receivedClock ? { ...receivedClock } : captureSystemClock()
      this.firstDataReceived = { systemClock, capturePoint: receivedClock ? 'transport_receive' : 'recorder_append', byteOffset: 0 }
      const record: SessionContextRecord = { schema: CONTEXT_SCHEMA, type: 'first_data_received',
        systemClock, firstDataReceived: this.firstDataReceived, t_ms: systemClock.monotonicMs,
        perf_ms: systemClock.monotonicMs, experiment: 'eeg', subjectId: '', byteOffset: 0,
        eeg: sampleClock.snapshot(systemClock.monotonicMs) }
      if (sessionHub.active) sessionHub.logContext(record)
      else this.lslBatches.push(record)
    }
    if (lsl || nativeFrames) {
      const systemClock = captureSystemClock()
      const now = systemClock.monotonicMs
      const record: SessionContextRecord = { schema: CONTEXT_SCHEMA, type: lsl ? 'lsl_timestamps' : 'omni_native_frames',
        systemClock, receivedClock: receivedClock ?? null,
        t_ms: now, perf_ms: now, experiment: 'eeg', subjectId: '', eeg: sampleClock.snapshot(now),
        byteOffset: this.bytes, byteLength: frameRaw.byteLength, ...(lsl ? { lsl } : { nativeFrames }) }
      // Disk context is streamed throughout recording, independent of the 1024-batch clock ring.
      if (sessionHub.active) sessionHub.logContext(record)
      else this.lslBatches.push(record)
    }
    let off = 0
    while (off < frameRaw.byteLength) {
      const n = Math.min(this.flushBytes - this.pendingLen, frameRaw.byteLength - off)
      this.pending.set(frameRaw.subarray(off, off + n), this.pendingLen)
      this.pendingLen += n
      off += n
      if (this.pendingLen === this.flushBytes) this.enqueueFlush()
    }
    this.bytes += frameRaw.byteLength
  }

  async stop(): Promise<RecordStopResult | null> {
    if (this.startedAt === null) return null
    this.startedAt = null
    const clock = sampleClock.dump()
    this.enqueueTail()
    try {
      await this.flushChain
    } catch (err) {
      console.error('[record] flush failed', err)
    }
    const bytes = this.bytes
    const name = this.filename
    const sink = this.sink
    const kind = sink?.kind ?? 'memory'
    const firstDataReceived = this.firstDataReceived
    const lslBatches = this.lslBatches
    this.lslBatches = []
    this.resetLocal()
    if (bytes === 0) {
      await sink?.abort()
      return null
    }
    try {
      const done = await sink?.finish({ firstDataReceived, ...(clock.sampleIndex > 0 ? { clock } : {}), ...(lslBatches.length ? { lslBatches } : {}) })
      return {
        bytes,
        name: done?.name ?? name,
        sink: kind,
        path: done?.path,
        rel: done?.rel,
      }
    } catch (err) {
      console.error('[record] finish failed', err)
      return { bytes, name, sink: kind }
    }
  }

  async discard(): Promise<void> {
    const sink = this.sink
    this.resetLocal()
    if (sink) await sink.abort()
  }

  private enqueueFlush(): void {
    const full = this.pending
    this.pending = new Uint8Array(this.flushBytes)
    this.pendingLen = 0
    this.queueWrite(full)
  }

  private enqueueTail(): void {
    if (this.pendingLen === 0) return
    const tail = this.pending.slice(0, this.pendingLen)
    this.pendingLen = 0
    this.queueWrite(tail)
  }

  private queueWrite(chunk: Uint8Array): void {
    const sink = this.sink
    if (!sink) return
    this.flushQueuedBytes += chunk.byteLength
    this.flushChain = this.flushChain.then(async () => {
      try {
        await sink.write(chunk)
      } finally {
        this.flushQueuedBytes = Math.max(0, this.flushQueuedBytes - chunk.byteLength)
      }
    })
  }

  private resetLocal(): void {
    this.firstDataReceived = null
    this.startedAt = null
    this.bytes = 0
    this.pendingLen = 0
    this.flushQueuedBytes = 0
    this.pending = new Uint8Array(this.flushBytes)
    this.sink = null
    this.flushChain = Promise.resolve()
  }
}
