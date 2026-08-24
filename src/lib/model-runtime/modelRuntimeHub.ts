import {
  subscribeRawBridgeBatches,
  type RawBridgeBatch,
} from '../../acquisition/runtime'
import {
  describeModelSource,
  describeWaitingModelSource,
  matchModelSourceProfile,
  projectRawBatchToProfile,
} from './sourceProfiles'
import {
  createProtocolId,
  MODEL_PROTOCOL_VERSION,
  parseServerMessage,
  type ModelFeedback,
  type ModelFeedbackAck,
  type ModelPrediction,
  type ModelServiceHello,
  type ModelServiceStatus,
  type ModelWindowPacket,
} from './contracts'
import { ModelWindowAssembler } from './windowAssembler'
import { modelServiceStatus } from './modelServiceApi'

const ENABLED_KEY = 'passive-bci.model-service-enabled'
const URL_KEY = 'passive-bci.model-service-url'
const MAX_PENDING = 2
const MAX_IN_FLIGHT = 2
const MAX_SOURCE_BATCHES = 8
const LATENCY_HISTORY = 120
const DEFAULT_WINDOW_SEC = 4
const DEFAULT_STEP_SEC = 0.5

const MAX_DEBUG_LOG = 80

export type ModelDebugLevel = 'info' | 'warn' | 'error'

export type ModelDebugEntry = {
  at_ms: number
  level: ModelDebugLevel
  message: string
  detail?: string
}

export type ModelRuntimeSnapshot = {
  enabled: boolean
  status: ModelServiceStatus
  url: string
  serviceHello: ModelServiceHello | null
  latestPrediction: ModelPrediction | null
  lastFeedbackAck: ModelFeedbackAck | null
  lastError: string
  sourceCompatible: boolean
  sourceDetail: string
  pendingWindows: number
  inFlightWindows: number
  sentWindows: number
  droppedWindows: number
  droppedSourceBatches: number
  predictionCount: number
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  socketReadyState: number | null
  lastCloseCode: number | null
  lastCloseReason: string
  windowSec: number
  stepSec: number
  debugLog: ModelDebugEntry[]
}

export type SubmitModelFeedbackOptions = {
  observationId: string
  label?: number
  reward?: number
  metadata?: Record<string, unknown>
}

function defaultModelUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8768'
  const configured = import.meta.env.VITE_MODEL_SERVICE_WS as string | undefined
  if (configured?.trim()) return configured.trim()
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  if (window.location.port && window.location.port !== '8768') {
    return `${proto}//${window.location.host}/ws/model`
  }
  return 'ws://127.0.0.1:8768'
}

export function modelUrlPresets(): { id: string; label: string; url: string }[] {
  const proxy =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/model`
      : 'ws://127.0.0.1:5173/ws/model'
  return [
    { id: 'direct', label: '直连 8768', url: 'ws://127.0.0.1:8768' },
    { id: 'proxy', label: 'Vite 代理', url: proxy },
  ]
}

function loadEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(ENABLED_KEY) === 'true'
}

function loadUrl(): string {
  if (typeof localStorage === 'undefined') return defaultModelUrl()
  return localStorage.getItem(URL_KEY)?.trim() || defaultModelUrl()
}

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]!
}

function waitingSourceDetail(): string {
  return `等待 ${describeWaitingModelSource()} 原始 EEG`
}

class ModelRuntimeHub {
  private socket: WebSocket | null = null
  private assembler = new ModelWindowAssembler({ windowSec: 4, stepSec: 0.5 })
  private listeners = new Set<() => void>()
  private pending: ModelWindowPacket[] = []
  private sourceQueue: RawBridgeBatch[] = []
  private sourceDraining = false
  private inFlight = new Set<string>()
  private sentWindowKeys = new Set<string>()
  private latencies: number[] = []
  private debugLog: ModelDebugEntry[] = []
  private connectSeq = 0
  private snapshotValue: ModelRuntimeSnapshot = {
    enabled: loadEnabled(),
    status: loadEnabled() ? 'closed' : 'disabled',
    url: loadUrl(),
    serviceHello: null,
    latestPrediction: null,
    lastFeedbackAck: null,
    lastError: '',
    sourceCompatible: false,
    sourceDetail: waitingSourceDetail(),
    pendingWindows: 0,
    inFlightWindows: 0,
    sentWindows: 0,
    droppedWindows: 0,
    droppedSourceBatches: 0,
    predictionCount: 0,
    p50LatencyMs: null,
    p95LatencyMs: null,
    socketReadyState: null,
    lastCloseCode: null,
    lastCloseReason: '',
    windowSec: DEFAULT_WINDOW_SEC,
    stepSec: DEFAULT_STEP_SEC,
    debugLog: [],
  }

  constructor() {
    subscribeRawBridgeBatches((batch) => this.enqueueSource(batch))
    if (this.snapshotValue.enabled && typeof window !== 'undefined') {
      queueMicrotask(() => this.connect())
    }
  }

  get snapshot(): ModelRuntimeSnapshot {
    return this.snapshotValue
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setEnabled(enabled: boolean): void {
    localStorage.setItem(ENABLED_KEY, String(enabled))
    this.patch({ enabled })
    this.logDebug('info', enabled ? '模型旁路已启用' : '模型旁路已关闭')
    if (enabled) this.connect()
    else this.disconnect('disabled')
  }

  setUrl(url: string): void {
    const next = url.trim() || defaultModelUrl()
    localStorage.setItem(URL_KEY, next)
    const reconnect = next !== this.snapshotValue.url && this.snapshotValue.enabled
    this.patch({ url: next })
    this.logDebug('info', `URL 已更新`, next)
    if (reconnect) this.connect()
  }

  clearDebugLog(): void {
    this.debugLog = []
    this.patch({ debugLog: [] })
  }

  sendHelloProbe(): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.logDebug('warn', 'hello 探测跳过', 'WebSocket 未连接')
      if (this.snapshotValue.enabled) this.connect()
      return
    }
    socket.send(
      JSON.stringify({
        type: 'hello',
        schema_version: MODEL_PROTOCOL_VERSION,
        client: 'passive-bci-debug',
      }),
    )
    this.logDebug('info', '已发送 hello 探测')
  }

  private usesDevStatusProbe(): boolean {
    return this.snapshotValue.url.includes('/ws/model')
  }

  private async serviceIsListening(): Promise<boolean> {
    try {
      const status = await modelServiceStatus()
      return status.running === true
    } catch {
      return false
    }
  }

  connect(): void {
    void this.connectAsync()
  }

  private async connectAsync(): Promise<void> {
    if (!this.snapshotValue.enabled) return
    const seq = ++this.connectSeq
    if (this.usesDevStatusProbe()) {
      this.patch({
        status: 'connecting',
        lastError: '',
        serviceHello: null,
        socketReadyState: WebSocket.CONNECTING,
      })
      const running = await this.serviceIsListening()
      if (seq !== this.connectSeq || !this.snapshotValue.enabled) return
      if (!running) {
        this.disconnectSocket()
        this.logDebug('warn', '跳过 WebSocket', '模型服务未在 :8768 监听')
        this.patch({
          status: 'closed',
          lastError: '模型服务未在 :8768 监听。请先点「启动 REVE」。',
          socketReadyState: null,
        })
        return
      }
    }
    if (seq !== this.connectSeq || !this.snapshotValue.enabled) return
    this.openSocket()
  }

  private openSocket(): void {
    this.disconnectSocket()
    this.patch({
      status: 'connecting',
      lastError: '',
      serviceHello: null,
      socketReadyState: WebSocket.CONNECTING,
    })
    this.logDebug('info', '正在连接', this.snapshotValue.url)
    let socket: WebSocket
    try {
      socket = new WebSocket(this.snapshotValue.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logDebug('error', '创建 WebSocket 失败', message)
      this.patch({
        status: 'error',
        lastError: message,
        socketReadyState: null,
      })
      return
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.pending = []
      this.inFlight.clear()
      this.sentWindowKeys.clear()
      if (this.snapshotValue.sourceCompatible) {
        this.assembler.bumpSegment()
      }
      this.patch({ socketReadyState: WebSocket.OPEN })
      this.logDebug('info', 'WebSocket 已连接')
      socket.send(
        JSON.stringify({
          type: 'hello',
          schema_version: MODEL_PROTOCOL_VERSION,
          client: 'passive-bci',
        }),
      )
      this.logDebug('info', '已发送 hello')
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        this.logDebug('info', '收到二进制帧', `${event.data instanceof ArrayBuffer ? event.data.byteLength : 0} bytes`)
        return
      }
      const preview =
        event.data.length > 240 ? `${event.data.slice(0, 240)}…` : event.data
      this.logDebug('info', '收到 JSON', preview)
      this.handleMessage(event.data)
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.logDebug('error', 'WebSocket 错误', this.snapshotValue.url)
      this.patch({
        status: 'error',
        lastError: '无法连接 NCC 模型服务（检查 URL、端口 8768 与服务进程）',
        socketReadyState: socket.readyState,
      })
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.inFlight.clear()
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`
      this.logDebug(event.wasClean ? 'info' : 'warn', 'WebSocket 已关闭', detail)
      this.patch({
        status: this.snapshotValue.enabled ? 'closed' : 'disabled',
        inFlightWindows: 0,
        socketReadyState: WebSocket.CLOSED,
        lastCloseCode: event.code,
        lastCloseReason: event.reason,
        lastError:
          event.code === 1000 && !this.snapshotValue.lastError
            ? ''
            : this.snapshotValue.lastError ||
              `连接关闭 (${event.code}${event.reason ? `: ${event.reason}` : ''})`,
      })
    }
  }

  disconnect(status: ModelServiceStatus = 'closed'): void {
    this.disconnectSocket()
    this.pending = []
    this.sourceQueue = []
    this.sourceDraining = false
    this.inFlight.clear()
    this.sentWindowKeys.clear()
    this.assembler = new ModelWindowAssembler({
      windowSec: DEFAULT_WINDOW_SEC,
      stepSec: DEFAULT_STEP_SEC,
    })
    this.patch({
      status,
      pendingWindows: 0,
      inFlightWindows: 0,
      sourceCompatible: false,
      sourceDetail: waitingSourceDetail(),
      windowSec: DEFAULT_WINDOW_SEC,
      stepSec: DEFAULT_STEP_SEC,
      socketReadyState: null,
    })
  }

  latestObservation(maxAgeMs = 5000): ModelPrediction | null {
    const prediction = this.snapshotValue.latestPrediction
    if (!prediction || performance.now() - prediction.received_at_ms > maxAgeMs) return null
    return prediction
  }

  submitFeedback(options: SubmitModelFeedbackOptions): string | null {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return null
    if (options.label == null && options.reward == null) return null
    const feedbackId = createProtocolId('feedback')
    const feedback: ModelFeedback = {
      type: 'feedback',
      schema_version: MODEL_PROTOCOL_VERSION,
      feedback_id: feedbackId,
      observation_id: options.observationId,
      timestamp_sec: Date.now() / 1000,
      ...(options.label == null ? {} : { label: options.label }),
      ...(options.reward == null ? {} : { reward: options.reward }),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    }
    this.socket.send(JSON.stringify(feedback))
    return feedbackId
  }

  private enqueueSource(batch: RawBridgeBatch): void {
    if (!this.snapshotValue.enabled) return
    if (this.sourceQueue.length >= MAX_SOURCE_BATCHES) {
      this.sourceQueue = []
      this.pending = []
      this.sentWindowKeys.clear()
      this.assembler.reset()
      this.patch({
        droppedSourceBatches: this.snapshotValue.droppedSourceBatches + 1,
        sourceCompatible: false,
        sourceDetail: '模型源批次积压，已丢弃并新建连续段',
      })
    }
    this.sourceQueue.push(batch)
    if (this.sourceDraining) return
    this.sourceDraining = true
    setTimeout(() => this.drainSource(), 0)
  }

  private drainSource(): void {
    const batch = this.sourceQueue.shift()
    if (!batch || !this.snapshotValue.enabled) {
      this.sourceDraining = false
      return
    }
    const matched = matchModelSourceProfile(batch)
    if (!matched) {
      this.pending = []
      this.sentWindowKeys.clear()
      this.assembler.reset()
      this.patch({
        sourceCompatible: false,
        sourceDetail:
          batch.device === 'neuracle' || batch.device === 'bcigo'
            ? `${batch.device} 通道布局未匹配已知模型源（${batch.channels} 导）`
            : `模型旁路暂不接收 ${batch.device}`,
      })
    } else {
      const projected = projectRawBatchToProfile(batch, matched)
      this.patch({
        sourceCompatible: true,
        sourceDetail: describeModelSource(matched.profile, projected, batch.channels),
      })
      try {
        for (const packet of this.assembler.push(projected)) this.enqueue(packet)
      } catch (error) {
        this.patch({
          sourceCompatible: false,
          sourceDetail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    setTimeout(() => this.drainSource(), 0)
  }

  private enqueue(packet: ModelWindowPacket): void {
    if (this.pending.length >= MAX_PENDING) {
      this.pending.shift()
      this.patch({ droppedWindows: this.snapshotValue.droppedWindows + 1 })
    }
    this.pending.push(packet)
    this.patch({ pendingWindows: this.pending.length })
    this.flush()
  }

  private flush(): void {
    const socket = this.socket
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.snapshotValue.status !== 'ready'
    ) {
      return
    }
    while (this.pending.length && this.inFlight.size < MAX_IN_FLIGHT) {
      const packet = this.pending.shift()!
      const windowKey = `${packet.header.segment_id}:${packet.header.window_id}`
      if (this.sentWindowKeys.has(windowKey)) {
        this.logDebug(
          'warn',
          `跳过重复窗口 #${packet.header.window_id}`,
          packet.header.segment_id,
        )
        this.patch({ pendingWindows: this.pending.length })
        continue
      }
      socket.send(JSON.stringify(packet.header))
      socket.send(packet.payload)
      this.sentWindowKeys.add(windowKey)
      this.inFlight.add(packet.header.request_id)
      this.logDebug(
        'info',
        `发送窗口 #${packet.header.window_id}`,
        `${packet.header.channels}×${packet.header.samples} @ ${packet.header.sample_rate}Hz`,
      )
      this.patch({
        pendingWindows: this.pending.length,
        inFlightWindows: this.inFlight.size,
        sentWindows: this.snapshotValue.sentWindows + 1,
      })
    }
  }

  private handleMessage(raw: string): void {
    try {
      const message = parseServerMessage(raw)
      if (message.type === 'hello') {
        this.applyInputContract(message)
        this.logDebug(
          'info',
          'hello 就绪',
          `${message.model_name ?? 'unknown'} · ${message.window_sec ?? this.snapshotValue.windowSec}s · ${message.class_names?.length ?? '?'} classes`,
        )
        this.patch({
          status: 'ready',
          serviceHello: message,
          lastError: '',
          socketReadyState: this.socket?.readyState ?? null,
        })
        this.flush()
        return
      }
      if (message.type === 'feedback_ack') {
        this.logDebug('info', 'feedback_ack', message.observation_id)
        this.patch({ lastFeedbackAck: message })
        return
      }
      if (message.type === 'error') {
        if (message.request_id) this.inFlight.delete(message.request_id)
        const err = `${message.code ? `${message.code}: ` : ''}${message.message}`
        this.logDebug('error', '服务端 error', err)
        if (
          message.code === 'duplicate_window_id' ||
          message.code === 'duplicate_request_id' ||
          message.code === 'non_monotonic_window'
        ) {
          this.pending = []
          this.sentWindowKeys.clear()
          this.assembler.bumpSegment()
          this.logDebug('warn', '已新建 segment，丢弃待发送窗口')
        }
        this.patch({
          lastError: err,
          inFlightWindows: this.inFlight.size,
          pendingWindows: this.pending.length,
        })
        this.flush()
        return
      }

      this.inFlight.delete(message.request_id)
      this.logDebug(
        'info',
        `prediction ${message.class_name}`,
        `${(message.confidence * 100).toFixed(1)}% · ${message.observation_id}`,
      )
      const latency = message.prepare_latency_ms + message.inference_latency_ms
      this.latencies.push(latency)
      if (this.latencies.length > LATENCY_HISTORY) this.latencies.shift()
      this.patch({
        latestPrediction: message,
        predictionCount: this.snapshotValue.predictionCount + 1,
        inFlightWindows: this.inFlight.size,
        p50LatencyMs: percentile(this.latencies, 0.5),
        p95LatencyMs: percentile(this.latencies, 0.95),
        lastError: '',
      })
      this.flush()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logDebug('error', '解析消息失败', message)
      this.patch({
        lastError: message,
      })
    }
  }

  private applyInputContract(hello: ModelServiceHello): void {
    const windowSec = hello.window_sec ?? DEFAULT_WINDOW_SEC
    const stepSec = hello.step_sec ?? DEFAULT_STEP_SEC
    if (!(windowSec > 0) || !(stepSec > 0) || stepSec > windowSec) {
      this.logDebug('warn', 'hello 切窗参数非法，保持当前窗', `${windowSec}/${stepSec}`)
      return
    }
    if (
      this.assembler.windowSec === windowSec &&
      this.assembler.stepSec === stepSec
    ) {
      this.patch({ windowSec, stepSec })
      return
    }
    this.assembler = new ModelWindowAssembler({ windowSec, stepSec })
    this.pending = []
    this.sentWindowKeys.clear()
    this.patch({
      windowSec,
      stepSec,
      pendingWindows: 0,
    })
    this.logDebug('info', `切窗已改为 ${windowSec}s`, `步长 ${stepSec}s`)
  }

  private logDebug(level: ModelDebugLevel, message: string, detail?: string): void {
    this.debugLog.push({
      at_ms: performance.now(),
      level,
      message,
      detail,
    })
    if (this.debugLog.length > MAX_DEBUG_LOG) {
      this.debugLog = this.debugLog.slice(-MAX_DEBUG_LOG)
    }
    this.patch({ debugLog: [...this.debugLog] })
  }

  private disconnectSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  }

  private patch(next: Partial<ModelRuntimeSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...next }
    for (const listener of this.listeners) listener()
  }
}

export const modelRuntimeHub = new ModelRuntimeHub()
