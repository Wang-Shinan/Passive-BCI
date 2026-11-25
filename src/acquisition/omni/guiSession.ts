import { acqRuntime, clearBridgeContinuity } from '../runtime'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { sessionHub } from '../../lib/session/sessionHub'
import { sampleClock } from '../../lib/eeg/sampleClock'
import { EVENT_SCHEMA, type SessionBindMeta } from '../../lib/session/contracts'
import type { RecordStartOptions, RecordStopResult } from '../session/recorder'
import {
  OmniGuiHttpClient,
  type GuiInterruption,
  type GuiStreamContext,
  type OmniGuiClientOptions,
} from './guiClient'
import { guiTriggerQueue, type GuiTriggerContext } from './guiTrigger'

const STM32_GUI_TRANSPORTS = new Set(['STM32', 'E73_BLE_32', 'E73_DONGLE', 'INTEL_BLE_32', 'INTEL_WIFI_32'])

export type GuiContinuityEvent =
  | { type: 'interrupt'; reason: string; detail: string; context: GuiStreamContext | null }
  | { type: 'ready'; context: GuiStreamContext }
  | { type: 'stopped'; reason: string }

export type GuiContinuityListener = (event: GuiContinuityEvent) => void | Promise<void>

const listeners = new Set<GuiContinuityListener>()
let activeSession: OmniGuiSession | null = null

export function subscribeGuiContinuity(listener: GuiContinuityListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function guiSessionActive(): boolean {
  return activeSession !== null
}

export function requestGuiRecovery(reason: string): boolean {
  if (!activeSession) return false
  activeSession.requestRecovery(reason)
  return true
}

export function suppressGuiSegmentReopen(): Promise<void> {
  return activeSession?.suppressNextReopen() ?? Promise.resolve()
}

type Boundary = {
  reason: string
  detail: string
  context: GuiStreamContext | null
  localId: string | null
  localRel: string | null
  wasStreaming: boolean
  wasRecording: boolean
  restart: RecordStartOptions | null
  boundMeta: SessionBindMeta
  suppressed: boolean
  errs: unknown[]
  savedResult: RecordStopResult | null
  saved: Promise<RecordStopResult | null>
}

export class OmniGuiSession {
  private readonly client: OmniGuiHttpClient
  private readonly port: number | undefined
  private closed = true
  private terminated = false
  private stoppedSent = false
  private boundary: Boundary | null = null
  private segmentChain: Promise<void> = Promise.resolve()

  constructor(opts: OmniGuiClientOptions) {
    this.port = opts.port
    this.client = new OmniGuiHttpClient({
      ...opts,
      autoRecover: true,
      onInterrupt: (event) => this.handleInterrupt(event),
      onReady: (context) => this.handleReady(context),
      onStatus: (s, d) => {
        opts.onStatus?.(s, d)
        if (s === 'live' && acqRuntime.streaming && acqRuntime.omni === this) {
          acqRuntime.status = 'streaming'
          liveEegHub.markStreaming(d)
        }
      },
      onError: (message) => {
        opts.onError?.(message)
      },
      onFatal: (message) => {
        opts.onError?.(message)
        this.terminalOnce(message)
      },
    })
  }

  connect(): void {
    this.closed = false
    this.terminated = false
    this.stoppedSent = false
    this.boundary = null
    activeSession = this
    guiTriggerQueue.setContextProvider(() => this.triggerContext())
    this.client.connect()
  }

  disconnect(): Promise<void> {
    this.closed = true
    const owned = activeSession === this && acqRuntime.omni === this
    const boundary = owned
      ? this.beginBoundary('disconnect', '手动断开连接', this.client.getStreamContext())
      : null
    this.terminated = true
    if (activeSession === this) {
      activeSession = null
      guiTriggerQueue.setContextProvider(null)
    }
    this.client.disconnect()
    if (!owned) return Promise.resolve()
    return this.serialize(async () => {
      if (boundary) {
        try {
          await boundary.saved
        } catch {
          void 0
        }
      }
      await this.publishStopped('disconnect')
    })
  }

  requestRecovery(reason: string): void {
    this.client.requestRecovery(reason)
  }

  get streamContext(): GuiStreamContext | null {
    return this.client.getStreamContext()
  }

  suppressNextReopen(): Promise<void> {
    if (this.boundary) this.boundary.suppressed = true
    return this.segmentChain
  }

  private isCurrent(): boolean {
    return !this.closed && !this.terminated && activeSession === this && acqRuntime.omni === this
  }

  private triggerContext(): GuiTriggerContext | null {
    if (!this.isCurrent()) return null
    if (acqRuntime.omniLink !== 'gui') return null
    if (this.boundary || this.client.isRecovering) return null
    const stream = this.client.getStreamContext()
    const localRecordingId = sessionHub.info.id
    if (!stream || !localRecordingId) return null
    if (!acqRuntime.recorder.recording) return null
    return {
      localRecordingId,
      upstreamSessionId: stream.sessionId,
      generation: stream.generation,
      segmentId: stream.segmentId,
      ...(this.port === undefined ? {} : { guiPort: this.port }),
      ...(stream.channelNames.length === 32 && STM32_GUI_TRANSPORTS.has(acqRuntime.omniGuiStatus?.transport?.toUpperCase() ?? '')
        ? { hardwareTrigger: true } : {}),
    }
  }

  private async publishStopped(reason: string): Promise<void> {
    if (this.stoppedSent || acqRuntime.omni !== this) return
    this.stoppedSent = true
    await this.publish({ type: 'stopped', reason })
  }

  private async publish(event: GuiContinuityEvent): Promise<unknown[]> {
    const tasks = [...listeners].map((listener) => {
      try {
        return Promise.resolve(listener(event)).then(
          () => undefined,
          (err) => err,
        )
      } catch (err) {
        return Promise.resolve(err)
      }
    })
    const results = await Promise.all(tasks)
    return results.filter((r) => r !== undefined)
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const run = this.segmentChain.then(step)
    this.segmentChain = run.catch(() => undefined)
    return run
  }

  private beginBoundary(reason: string, detail: string, context: GuiStreamContext | null): Boundary | null {
    if (this.boundary) return this.boundary
    if (this.terminated) return null
    if (acqRuntime.omni !== this) return null
    const b: Boundary = {
      reason,
      detail,
      context,
      localId: sessionHub.info.id,
      localRel: sessionHub.info.rel,
      wasStreaming: acqRuntime.streaming,
      wasRecording: acqRuntime.recorder.recording,
      restart: acqRuntime.recorder.recording ? acqRuntime.recorder.restartOptions : null,
      boundMeta: sessionHub.boundMeta,
      suppressed: false,
      errs: [],
      savedResult: null,
      saved: Promise.resolve(null),
    }
    this.boundary = b
    acqRuntime.streaming = false
    acqRuntime.ui?.onBridgeReset?.('reset')
    liveEegHub.clearSamples()
    let releaseGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    if (b.localId) {
      sessionHub.defer(b.localId, gate)
      sessionHub.logEventFor(b.localId, {
        schema: EVENT_SCHEMA,
        t_ms: 0,
        perf_ms: performance.now(),
        experiment: 'acquisition',
        subjectId: b.boundMeta.subjectId ?? 'acquisition',
        type: 'acquisition_interrupted',
        data: {
          reason,
          detail,
          runId: b.boundMeta.runId ?? null,
          upstreamSessionId: context?.sessionId ?? null,
          generation: context?.generation ?? null,
          segmentId: context?.segmentId ?? null,
        },
        eeg: sampleClock.snapshot(),
        eventId: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `ev-${Date.now().toString(36)}`,
      })
    }
    const trigStop = guiTriggerQueue.interrupt()
    const stopPromise = b.wasRecording
      ? acqRuntime.recorder.stop({ interrupted: true, interruptionReason: reason })
      : null
    b.saved = (async () => {
      const canPublish = acqRuntime.omni === this
      const errs = canPublish
        ? await this.publish({ type: 'interrupt', reason, detail, context })
        : []
      b.errs = errs
      releaseGate()
      await trigStop
      if (acqRuntime.omni === this) clearBridgeContinuity()
      const result = stopPromise ? await stopPromise : null
      if (result?.error) throw new Error(`中断片段保存失败：${result.error}`)
      b.savedResult = result
      return result
    })()
    return b
  }

  private handleInterrupt(event: GuiInterruption): Promise<void> {
    const b = this.beginBoundary(event.reason, event.detail, event.context)
    if (!b) return Promise.resolve()
    return this.serialize(async () => {
      try {
        await b.saved
      } catch (err) {
        this.terminated = true
        await this.publishStopped(err instanceof Error ? err.message : String(err))
        throw err
      }
      if (b.errs.length) {
        const first = b.errs[0]
        this.terminated = true
        await this.publishStopped(`中断处理失败：${first instanceof Error ? first.message : String(first)}`)
        throw first instanceof Error ? first : new Error(String(first))
      }
    })
  }

  private handleReady(context: GuiStreamContext): Promise<void> {
    return this.serialize(() => this.readyOnce(context))
  }

  private async readyOnce(context: GuiStreamContext): Promise<void> {
    if (!this.isCurrent()) return
    const b = this.boundary
    if (!b) {
      await this.publish({ type: 'ready', context })
      return
    }
    const saved = await b.saved.then(
      () => true,
      () => false,
    )
    if (!this.isCurrent() || this.boundary !== b) return
    if (!saved) {
      this.terminated = true
      await this.publishStopped('中断片段保存失败，停止恢复')
      throw new Error('中断片段保存失败')
    }
    if (b.errs.length) {
      const first = b.errs[0]
      this.terminated = true
      await this.publishStopped(`中断处理失败：${first instanceof Error ? first.message : String(first)}`)
      throw first instanceof Error ? first : new Error(String(first))
    }
    const canReopen = b.wasRecording && b.restart && !b.suppressed
    if (canReopen) {
      const meta = {
        ...(b.restart!.meta ?? {}),
        ...(b.boundMeta.runId ? { runId: b.boundMeta.runId } : {}),
        recovery: {
          reason: b.reason,
          fromCursor: context.reset?.fromCursor ?? null,
          toCursor: context.reset?.toCursor ?? null,
          previousSegmentId: b.localId,
          previousSegmentRel: b.localRel,
          previousSegmentName: b.savedResult?.name ?? null,
          guiSessionId: context.sessionId,
          guiGeneration: context.generation,
          guiSegment: context.segmentId,
        },
      }
      let sink: string
      try {
        sink = await acqRuntime.recorder.start({ ...b.restart!, meta })
      } catch (err) {
        this.terminated = true
        await this.publishStopped(`恢复录制失败：${err instanceof Error ? err.message : String(err)}`)
        throw err instanceof Error ? err : new Error(String(err))
      }
      const openedId = sessionHub.info.id
      if (!this.isCurrent() || b.suppressed) {
        if (acqRuntime.omni === this && sessionHub.info.id === openedId && acqRuntime.recorder.recording) {
          await acqRuntime.recorder.stop({
            interrupted: true,
            interruptionReason: 'reopen_cancelled',
          }).catch(() => undefined)
        }
        if (!this.isCurrent()) return
      }
      if (sink !== 'disk') {
        await acqRuntime.recorder.discard().catch(() => undefined)
        const err = new Error(`恢复录制未落盘（sink=${sink}）`)
        this.terminated = true
        await this.publishStopped(err.message)
        throw err
      }
      sessionHub.bindMeta({ ...b.boundMeta })
    }
    if (!this.isCurrent()) return
    if (b.wasStreaming) {
      acqRuntime.streaming = true
      acqRuntime.ui?.onBridgeReset?.('resume')
    }
    if (this.boundary === b) this.boundary = null
    if (!b.suppressed) await this.publish({ type: 'ready', context })
  }

  private terminalOnce(reason: string): void {
    if (this.terminated) return
    const owned = acqRuntime.omni === this
    const b = owned
      ? this.beginBoundary(reason, reason, this.client.getStreamContext())
      : null
    this.terminated = true
    this.closed = true
    if (activeSession === this) {
      activeSession = null
      guiTriggerQueue.setContextProvider(null)
    }
    this.client.disconnect()
    if (!owned) return
    void this.serialize(async () => {
      let saveErr: unknown = null
      try {
        if (b) await b.saved
      } catch (err) {
        saveErr = err
      }
      const detail = saveErr
        ? `${reason}；片段保存失败：${saveErr instanceof Error ? saveErr.message : String(saveErr)}`
        : reason
      await this.publishStopped(detail)
    })
  }
}
