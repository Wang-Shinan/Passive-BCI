/** OmniBCI LSL bridge WebSocket protocol (schema v1). */
import type { LslTiming } from '../../lib/eeg/lslClock'
import type { NativeFrame } from './native'
import type { SystemClockStamp } from '../../lib/eeg/systemClock'

export const OMNI_API_SCHEMA = 1
export const OMNI_API_PORT = 8771
export const OMNI_SAMPLE_RATE = 250
export const OMNI_CHANNELS = 8
export const OMNI_CHANNEL_NAMES = [
  'CH1',
  'CH2',
  'CH3',
  'CH4',
  'CH5',
  'CH6',
  'CH7',
  'CH8',
] as const
export const OMNI_STREAM_RAW = 'raw'
export const OMNI_STREAM_FILTERED = 'filtered'

export type OmniStreamKind = typeof OMNI_STREAM_RAW | typeof OMNI_STREAM_FILTERED

export type OmniHello = {
  type: 'hello'
  schema_version: number
  stream: OmniStreamKind
  sample_rate: number
  channels: string[]
  unit: string
  session_id?: string
}

export type OmniGapEvent = {
  type: 'gap'
  stream: string
  dropped_batches: number
  dropped_samples: number
  dropped_markers: number
}

export type OmniMarkerEvent = {
  type: 'marker'
  event_id: string
  session_id: string
  recording_id: string
  code: string
  value: null | boolean | number | string
  timestamp: number
  sequence: number | null
  duration: number
  description: string
}

export type OmniDataBatch = {
  receivedClock?: SystemClockStamp
  nativeFrames?: NativeFrame[]
  lsl?: LslTiming
  values: Float32Array
  samples: number
  channels: number
  sampleRate: number
  channelNames: string[]
  unit: string
  stream: OmniStreamKind
  sequence: Uint32Array
  valid: Uint8Array
  modes: Uint8Array
  generation: number | null
  sessionId: string
  packetCount: number
  packetLoss: number
}

export type ParsedOmniText =
  | { kind: 'hello'; hello: OmniHello }
  | { kind: 'gap'; gap: OmniGapEvent }
  | { kind: 'marker'; marker: OmniMarkerEvent }
  | { kind: 'data-header'; header: Record<string, unknown> }
  | { kind: 'error'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null
  if (!value.every((item) => typeof item === 'string' && item.length > 0)) return null
  return value as string[]
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

export function parseOmniText(text: string, expectedStream: OmniStreamKind): ParsedOmniText {
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    return { kind: 'error', message: 'OmniBCI 返回了非法 JSON' }
  }
  if (!isRecord(msg)) return { kind: 'error', message: 'OmniBCI 事件必须是对象' }

  if (msg.type === 'hello') {
    const stream = msg.stream === OMNI_STREAM_FILTERED ? OMNI_STREAM_FILTERED : OMNI_STREAM_RAW
    const channels = asStringList(msg.channels)
    const sampleRate = asFiniteNumber(msg.sample_rate)
    if (msg.schema_version !== OMNI_API_SCHEMA) {
      return { kind: 'error', message: `OmniBCI schema 不兼容（${String(msg.schema_version)}）` }
    }
    if (stream !== expectedStream) {
      return { kind: 'error', message: 'hello.stream 与订阅不一致' }
    }
    if (!channels || sampleRate == null || msg.unit !== 'uV') {
      return { kind: 'error', message: 'OmniBCI hello 缺少通道 / 采样率 / μV 单位' }
    }
    return {
      kind: 'hello',
      hello: {
        type: 'hello',
        schema_version: OMNI_API_SCHEMA,
        stream,
        sample_rate: sampleRate,
        channels,
        unit: 'uV',
        session_id: typeof msg.session_id === 'string' ? msg.session_id : undefined,
      },
    }
  }

  if (msg.type === 'gap') {
    if (msg.stream !== expectedStream) {
      return { kind: 'error', message: 'gap.stream 与订阅不一致' }
    }
    return {
      kind: 'gap',
      gap: {
        type: 'gap',
        stream: expectedStream,
        dropped_batches: Number(msg.dropped_batches) || 0,
        dropped_samples: Number(msg.dropped_samples) || 0,
        dropped_markers: Number(msg.dropped_markers) || 0,
      },
    }
  }

  if (msg.type === 'marker') {
    return {
      kind: 'marker',
      marker: {
        type: 'marker',
        event_id: String(msg.event_id ?? ''),
        session_id: String(msg.session_id ?? ''),
        recording_id: String(msg.recording_id ?? ''),
        code: String(msg.code ?? ''),
        value:
          msg.value === null ||
          typeof msg.value === 'boolean' ||
          typeof msg.value === 'number' ||
          typeof msg.value === 'string'
            ? msg.value
            : null,
        timestamp: Number(msg.timestamp) || 0,
        sequence: typeof msg.sequence === 'number' ? msg.sequence : null,
        duration: Number(msg.duration) || 0,
        description: String(msg.description ?? ''),
      },
    }
  }

  if (msg.type === 'error') {
    return { kind: 'error', message: String(msg.message ?? 'OmniBCI 返回错误') }
  }

  if (msg.type === 'data') {
    return { kind: 'data-header', header: msg }
  }

  return { kind: 'error', message: `未识别的 OmniBCI 事件：${String(msg.type)}` }
}

function intArray(value: unknown, length: number, max: number): Uint32Array | null {
  if (!Array.isArray(value) || value.length !== length) return null
  const out = new Uint32Array(length)
  for (let i = 0; i < length; i++) {
    const n = value[i]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) return null
    out[i] = n
  }
  return out
}

function boolArray(value: unknown, length: number): Uint8Array | null {
  if (!Array.isArray(value) || value.length !== length) return null
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    if (typeof value[i] !== 'boolean') return null
    out[i] = value[i] ? 1 : 0
  }
  return out
}

export function decodeOmniDataBatch(
  header: Record<string, unknown>,
  payload: ArrayBuffer,
  expectedStream: OmniStreamKind,
): OmniDataBatch | { error: string } {
  if (header.schema_version !== OMNI_API_SCHEMA) {
    return { error: 'data schema 不兼容' }
  }
  if (header.dtype !== 'float32') return { error: 'data.dtype 必须是 float32' }
  if (header.stream !== expectedStream) return { error: 'data.stream 与订阅不一致' }
  const shape = header.shape
  if (
    !Array.isArray(shape) ||
    shape.length !== 2 ||
    !shape.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
  ) {
    return { error: 'data.shape 无效' }
  }
  const samples = shape[0]!
  const channels = shape[1]!
  const channelNames = asStringList(header.channels)
  if (!channelNames || channelNames.length !== channels) {
    return { error: 'data.channels 与 shape 不一致' }
  }
  const expectedBytes = samples * channels * 4
  if (payload.byteLength !== expectedBytes) {
    return { error: `payload 长度不匹配 ${payload.byteLength}≠${expectedBytes}` }
  }
  const sequence = intArray(header.sequence, samples, 0xffffffff)
  const modes = intArray(header.modes, samples, 0xff)
  const valid = boolArray(header.valid, samples)
  if (!sequence || !modes || !valid) {
    return { error: 'data 元数据（sequence / valid / modes）无效' }
  }
  const sampleRate = asFiniteNumber(header.sample_rate) ?? OMNI_SAMPLE_RATE
  let lsl: LslTiming | undefined
  if (header.lsl !== undefined) {
    const timing = header.lsl
    if (!isRecord(timing) || !Array.isArray(timing.timestampsSec) || timing.timestampsSec.length !== samples
      || !timing.timestampsSec.every(t => typeof t === 'number' && Number.isFinite(t))
      || !(timing.correctionSec === null || asFiniteNumber(timing.correctionSec) !== null)
      || asFiniteNumber(timing.correctionAtSec) === null || typeof timing.streamId !== 'string') {
      return { error: 'LSL 时间戳数量或时钟元数据无效' }
    }
    lsl = timing as LslTiming
  }
  return {
    lsl,
    values: new Float32Array(payload.slice(0)),
    samples,
    channels,
    sampleRate,
    channelNames,
    unit: String(header.unit ?? 'uV'),
    stream: expectedStream,
    sequence,
    valid,
    modes: Uint8Array.from(modes, (n) => n & 0xff),
    generation: typeof header.generation === 'number' ? header.generation : null,
    sessionId: String(header.session_id ?? ''),
    packetCount: Number(header.packet_count) || 0,
    packetLoss: Number(header.packet_loss_count) || 0,
  }
}

export function sequenceGaps(sequence: Uint32Array, prev: number | null): {
  gaps: number
  last: number | null
} {
  let gaps = 0
  let last = prev
  for (let i = 0; i < sequence.length; i++) {
    const seq = sequence[i]!
    if (last !== null) {
      const delta = (seq - last) >>> 0
      if (delta > 1 && delta < 1_000_000) gaps += delta - 1
    }
    last = seq
  }
  return { gaps, last }
}
