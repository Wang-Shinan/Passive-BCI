import { OMNI_STREAM_RAW, type OmniDataBatch } from './protocol'

export type GuiDataPage = {
  generation: number
  oldestCursor: number
  endCursor: number
  nextCursor: number
  batch: Omit<OmniDataBatch, 'packetCount' | 'packetLoss' | 'sessionId'> & {
    sourceTimestampUs: Uint32Array
    sourceTimestampValid: Uint8Array
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GUI ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function integer(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`GUI ${label} is not a safe unsigned integer`)
  }
  return value
}

/** GUI /v1/data uses original device rows, not the LSL/header+binary protocol. */
export function decodeGuiDataPage(value: unknown): GuiDataPage {
  const page = record(value, 'data page')
  if (page.source !== 'original_device_frames') {
    throw new Error('GUI data source must be original_device_frames')
  }
  const generation = integer(page.generation, 'generation')
  const oldestCursor = integer(page.oldest_cursor, 'oldest_cursor')
  const endCursor = integer(page.end_cursor, 'end_cursor')
  const nextCursor = integer(page.next_cursor, 'next_cursor')
  const channelNames = page.channel_names
  if (!Array.isArray(channelNames) || !channelNames.length ||
      !channelNames.every(name => typeof name === 'string' && name.length > 0)) {
    throw new Error('GUI channel_names is empty or invalid; start EEG acquisition in the GUI first')
  }
  const sampleRate = page.sample_rate_hz
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('GUI sample_rate_hz is invalid')
  }
  if (!Array.isArray(page.frames) || page.frames.length > 5000) {
    throw new Error('GUI frames must be an array of at most 5000 rows')
  }
  const samples = page.frames.length
  if (oldestCursor > endCursor || nextCursor < oldestCursor ||
      nextCursor > endCursor || nextCursor - samples < oldestCursor) {
    throw new Error('GUI cursor bounds do not match the returned rows')
  }
  const channels = channelNames.length
  const values = new Float32Array(samples * channels)
  const sequence = new Uint32Array(samples)
  const valid = new Uint8Array(samples)
  const modes = new Uint8Array(samples)
  const sourceTimestampUs = new Uint32Array(samples)
  const sourceTimestampValid = new Uint8Array(samples)
  for (let i = 0; i < samples; i++) {
    const frame = record(page.frames[i], `frame ${i}`)
    const row = frame.values_uv
    if (!Array.isArray(row) || row.length !== channels ||
        !row.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 3.4028234663852886e38)) {
      throw new Error(`GUI frame ${i} values_uv does not match finite float32 channel data`)
    }
    values.set(row, i * channels)
    sequence[i] = integer(frame.sequence, `frame ${i} sequence`, 0xffffffff)
    modes[i] = integer(frame.mode, `frame ${i} mode`, 0xff)
    if (typeof frame.valid !== 'boolean') throw new Error(`GUI frame ${i} valid is not boolean`)
    valid[i] = frame.valid ? 1 : 0
    if (frame.source_timestamp_us !== null && frame.source_timestamp_us !== undefined) {
      sourceTimestampUs[i] = integer(frame.source_timestamp_us, `frame ${i} source_timestamp_us`, 0xffffffff)
      sourceTimestampValid[i] = 1
    }
  }
  return {
    generation, oldestCursor, endCursor, nextCursor,
    batch: {
      values, samples, channels, sampleRate, channelNames: [...channelNames],
      unit: 'uV', stream: OMNI_STREAM_RAW, sequence, valid, modes, generation,
      sourceTimestampUs, sourceTimestampValid,
    },
  }
}
