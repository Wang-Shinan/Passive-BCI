export const MODEL_PROTOCOL_VERSION = 1

export type ModelServiceStatus =
  | 'disabled'
  | 'connecting'
  | 'ready'
  | 'error'
  | 'closed'

export type ModelWindowHeader = {
  type: 'window'
  schema_version: typeof MODEL_PROTOCOL_VERSION
  request_id: string
  window_id: number
  segment_id: string
  sample_rate: number
  channel_names: string[]
  unit: 'uV'
  layout: 'CT'
  channels: number
  samples: number
  sample_count: number
  start_time_sec: number
  end_time_sec: number
}

export type ModelWindowPacket = {
  header: ModelWindowHeader
  /** Contiguous little-endian float32 data in [channel, time] order. */
  payload: ArrayBuffer
}

export type ModelServiceHello = {
  type: 'hello'
  schema_version: number
  service?: string
  model_name?: string
  model_type?: string
  task?: string
  class_names?: string[]
  model_revision?: string
  strategy?: string
}

export type ModelPrediction = {
  type: 'prediction'
  schema_version: number
  request_id: string
  observation_id: string
  window_id: number
  segment_id: string
  class_id: number
  class_name: string
  class_names: string[]
  probabilities: number[]
  confidence: number
  model_revision: string
  online_update_step: number
  online_update_applied: boolean
  prepare_latency_ms: number
  inference_latency_ms: number
  task?: string
  output_semantics?: string
  received_at_ms: number
}

export type ModelFeedback = {
  type: 'feedback'
  schema_version: typeof MODEL_PROTOCOL_VERSION
  feedback_id: string
  observation_id: string
  label?: number
  reward?: number
  timestamp_sec: number
  metadata?: Record<string, unknown>
}

export type ModelFeedbackAck = {
  type: 'feedback_ack'
  schema_version: number
  feedback_id: string
  observation_id: string
  accepted: boolean
  duplicate?: boolean
  reason?: string
  model_revision?: string
  online_update_step?: number
  online_update_applied?: boolean
}

export type ModelServiceError = {
  type: 'error'
  schema_version?: number
  code?: string
  message: string
  request_id?: string
  observation_id?: string
}

export type ModelServerMessage =
  | ModelServiceHello
  | ModelPrediction
  | ModelFeedbackAck
  | ModelServiceError

export function createProtocolId(prefix: string): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${id}`
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function coerceWindowId(value: unknown): number | null {
  if (finiteNumber(value) && value >= 0 && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  return null
}

function parseHello(value: Record<string, unknown>): ModelServiceHello {
  const model =
    value.model && typeof value.model === 'object'
      ? (value.model as Record<string, unknown>)
      : null
  const online =
    value.online && typeof value.online === 'object'
      ? (value.online as Record<string, unknown>)
      : null
  const classNamesRaw = value.class_names ?? model?.class_names
  const classNames = Array.isArray(classNamesRaw)
    ? classNamesRaw.filter((name): name is string => typeof name === 'string')
    : undefined
  return {
    type: 'hello',
    schema_version: finiteNumber(value.schema_version) ? value.schema_version : 0,
    service: typeof value.service === 'string' ? value.service : undefined,
    model_name:
      (typeof value.model_name === 'string' ? value.model_name : undefined) ??
      (typeof model?.name === 'string' ? model.name : undefined),
    model_type:
      (typeof value.model_type === 'string' ? value.model_type : undefined) ??
      (typeof model?.type === 'string' ? model.type : undefined),
    task:
      (typeof value.task === 'string' ? value.task : undefined) ??
      (typeof model?.task === 'string' ? model.task : undefined),
    class_names: classNames,
    model_revision:
      (typeof value.model_revision === 'string' ? value.model_revision : undefined) ??
      (typeof online?.model_revision === 'string' ? online.model_revision : undefined),
    strategy:
      (typeof value.strategy === 'string' ? value.strategy : undefined) ??
      (typeof online?.strategy === 'string' ? online.strategy : undefined),
  }
}

export function parseServerMessage(raw: string): ModelServerMessage {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
    throw new Error('模型服务返回的消息缺少 type')
  }
  if (value.type === 'hello') {
    return parseHello(value)
  }
  if (value.type === 'feedback_ack') {
    if (typeof value.feedback_id !== 'string' || typeof value.observation_id !== 'string') {
      throw new Error('feedback_ack 缺少反馈标识')
    }
    return {
      type: 'feedback_ack',
      schema_version: finiteNumber(value.schema_version) ? value.schema_version : 0,
      feedback_id: value.feedback_id,
      observation_id: value.observation_id,
      accepted: typeof value.accepted === 'boolean' ? value.accepted : true,
      duplicate: value.duplicate === true,
      reason: typeof value.reason === 'string' ? value.reason : undefined,
      model_revision:
        typeof value.model_revision === 'string' ? value.model_revision : undefined,
      online_update_step: finiteNumber(value.online_update_step)
        ? value.online_update_step
        : undefined,
      online_update_applied:
        typeof value.online_update_applied === 'boolean'
          ? value.online_update_applied
          : undefined,
    }
  }
  if (value.type === 'error') {
    return {
      type: 'error',
      schema_version: finiteNumber(value.schema_version) ? value.schema_version : undefined,
      code: typeof value.code === 'string' ? value.code : undefined,
      message: String(value.message ?? '模型服务错误'),
      request_id: typeof value.request_id === 'string' ? value.request_id : undefined,
      observation_id:
        typeof value.observation_id === 'string' ? value.observation_id : undefined,
    }
  }
  if (value.type !== 'prediction') {
    throw new Error(`未知模型服务消息：${value.type}`)
  }

  const probabilities = value.probabilities
  const classNames = value.class_names
  const windowId = coerceWindowId(value.window_id)
  if (
    typeof value.request_id !== 'string' ||
    typeof value.observation_id !== 'string' ||
    typeof value.segment_id !== 'string' ||
    windowId == null ||
    !finiteNumber(value.class_id) ||
    typeof value.class_name !== 'string' ||
    !Array.isArray(probabilities) ||
    !probabilities.every(finiteNumber) ||
    !Array.isArray(classNames) ||
    !classNames.every((name) => typeof name === 'string') ||
    probabilities.length !== classNames.length ||
    !finiteNumber(value.confidence)
  ) {
    throw new Error('模型 prediction 消息不符合协议')
  }

  return {
    type: 'prediction',
    schema_version: finiteNumber(value.schema_version) ? value.schema_version : 0,
    request_id: value.request_id,
    observation_id: value.observation_id,
    window_id: windowId,
    segment_id: value.segment_id,
    class_id: value.class_id,
    class_name: value.class_name,
    class_names: classNames as string[],
    probabilities: probabilities as number[],
    confidence: value.confidence,
    model_revision: String(value.model_revision ?? 'base'),
    online_update_step: finiteNumber(value.online_update_step)
      ? value.online_update_step
      : 0,
    online_update_applied: value.online_update_applied === true,
    prepare_latency_ms: finiteNumber(value.prepare_latency_ms)
      ? value.prepare_latency_ms
      : 0,
    inference_latency_ms: finiteNumber(value.inference_latency_ms)
      ? value.inference_latency_ms
      : 0,
    task: typeof value.task === 'string' ? value.task : undefined,
    output_semantics:
      typeof value.output_semantics === 'string' ? value.output_semantics : undefined,
    received_at_ms: performance.now(),
  }
}

/**
 * Only explicitly-declared ordinal three-class heads may drive TAMER rewards.
 * A 3-class model with unknown semantics is not assumed to mean bad/neutral/good.
 */
export function predictionToOrdinalRating(prediction: ModelPrediction): -1 | 0 | 1 | null {
  if (prediction.output_semantics !== 'ordinal_rating_3') return null
  if (prediction.probabilities.length !== 3) return null
  if (prediction.class_id === 0) return -1
  if (prediction.class_id === 1) return 0
  if (prediction.class_id === 2) return 1
  return null
}
