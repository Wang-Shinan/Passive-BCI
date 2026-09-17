import type { OmniDataBatch } from './protocol'

export type NativeFrame = { sequence: number; values_uv: number[]; valid: boolean; mode: number
  source_timestamp_ms: number | null; raw_counts?: number[]; status?: number[]; triggers?: unknown[] }
export function decodeNativeEeg(text: string): OmniDataBatch {
  const msg = JSON.parse(text)
  if (msg?.type !== 'eeg' || !Number.isFinite(msg.sample_rate_hz) || msg.sample_rate_hz <= 0
    || !Array.isArray(msg.channel_names) || !msg.channel_names.length || !msg.channel_names.every((s: unknown) => typeof s === 'string')
    || !Array.isArray(msg.frames) || !msg.frames.length) throw new Error('OmniBCI 原生 EEG 消息格式无效')
  const frames = msg.frames as NativeFrame[]
  const channels = msg.channel_names.length
  for (const f of frames) {
    if (!f || !Number.isInteger(f.sequence) || f.sequence < 0 || f.sequence > 0xffffffff
      || !Array.isArray(f.values_uv) || f.values_uv.length !== channels || !f.values_uv.every(Number.isFinite)
      || typeof f.valid !== 'boolean' || !Number.isInteger(f.mode) || f.mode < 0 || f.mode > 255
      || !(f.source_timestamp_ms === null || Number.isFinite(f.source_timestamp_ms))) throw new Error('OmniBCI 原生 EEG 帧无效')
  }
  return { values: Float32Array.from(frames.flatMap(f => f.values_uv)), samples: frames.length, channels,
    sampleRate: msg.sample_rate_hz, channelNames: msg.channel_names, unit: 'uV', stream: 'raw',
    sequence: Uint32Array.from(frames.map(f => f.sequence)), valid: Uint8Array.from(frames.map(f => Number(f.valid))),
    modes: Uint8Array.from(frames.map(f => f.mode)), generation: null, sessionId: '', packetCount: 0, packetLoss: 0,
    nativeFrames: frames }
}

export async function nativeHealth() {
  const response = await fetch('/api/omni-native/health', { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error('请在 OmniBCI 启用 Web API / Trigger（8766）')
  const data = await response.json()
  if (typeof data.connected !== 'boolean' || typeof data.streaming !== 'boolean') throw new Error('8766 端口不是 OmniBCI 原生 API')
  return data as { connected: boolean; streaming: boolean; session_id: string | null; latest_sequence: number | null }
}

export type TriggerAck = { accepted: true; session_id: string; code: number; label: string | null
  host_time: string; sequence: number; sample_index: number }
export async function sendNativeTrigger(code: number, label: string): Promise<TriggerAck> {
  if (!Number.isInteger(code) || code < 0 || code > 65535 || [...label].length > 128) throw new Error('Trigger code 必须为 0–65535，label 最多 128 字符')
  // Do not retry: a timed-out request may already have been written by the device application.
  const response = await fetch('/api/omni-native/v1/trigger', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label }), signal: AbortSignal.timeout(3000) })
  const data = await response.json()
  if (!response.ok || data.accepted !== true) throw new Error(data.error || `Trigger 请求失败（${response.status}）`)
  if (data.code !== code || typeof data.session_id !== 'string' || !Number.isInteger(data.sequence)
    || !Number.isInteger(data.sample_index) || typeof data.host_time !== 'string') throw new Error('Trigger 回执格式无效')
  return data as TriggerAck
}
