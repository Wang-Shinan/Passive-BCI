import {
  createProtocolId,
  MODEL_PROTOCOL_VERSION,
  type ModelWindowPacket,
} from './contracts'

export type ModelSourceBatch = {
  values: Float32Array
  samples: number
  channels: number
  sampleRate: number
  channelNames: string[]
  unit: string
  packetLoss: number
  packetCount: number
  device: string
  streamId: number
}

export type WindowAssemblerOptions = {
  windowSec?: number
  stepSec?: number
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

/**
 * Builds exact raw EEG windows without reading the display ring.
 *
 * Input bridge batches are sample-major interleaved. Emitted payloads are
 * contiguous channel-major float32 ([channel, time]) for RawEEGWindow(layout=CT).
 */
export class ModelWindowAssembler {
  readonly windowSec: number
  readonly stepSec: number

  private buffers: Float32Array[] = []
  private capacity = 0
  private writeHead = 0
  private filled = 0
  private newSinceEmit = 0
  private segmentSamples = 0
  private segmentCounter = 0
  private segmentId = ''
  private emitSequence = 0
  private sampleRate = 0
  private channelNames: string[] = []
  private device = ''
  private streamId = 0
  private lastPacketLoss = 0
  private lastPacketCount = 0

  constructor(options: WindowAssemblerOptions = {}) {
    this.windowSec = options.windowSec ?? 4
    this.stepSec = options.stepSec ?? 0.5
    if (!(this.windowSec > 0) || !(this.stepSec > 0) || this.stepSec > this.windowSec) {
      throw new Error('模型窗口参数必须满足 0 < stepSec <= windowSec')
    }
  }

  reset(): void {
    this.buffers = []
    this.capacity = 0
    this.writeHead = 0
    this.filled = 0
    this.newSinceEmit = 0
    this.segmentSamples = 0
    this.segmentId = ''
    this.sampleRate = 0
    this.channelNames = []
    this.device = ''
    this.streamId = 0
    this.lastPacketLoss = 0
    this.lastPacketCount = 0
  }

  push(batch: ModelSourceBatch): ModelWindowPacket[] {
    this.validateBatch(batch)
    const identityChanged =
      this.sampleRate !== batch.sampleRate ||
      this.device !== batch.device ||
      this.streamId !== batch.streamId ||
      !sameNames(this.channelNames, batch.channelNames)
    const discontinuity =
      identityChanged ||
      batch.packetLoss > this.lastPacketLoss ||
      (this.lastPacketCount > 0 && batch.packetCount < this.lastPacketCount)

    if (!this.segmentId || discontinuity) this.beginSegment(batch)
    this.lastPacketLoss = batch.packetLoss
    this.lastPacketCount = batch.packetCount

    const emitted: ModelWindowPacket[] = []
    const stepSamples = Math.max(1, Math.round(this.stepSec * this.sampleRate))
    for (let sample = 0; sample < batch.samples; sample++) {
      const offset = sample * batch.channels
      for (let channel = 0; channel < batch.channels; channel++) {
        this.buffers[channel]![this.writeHead] = batch.values[offset + channel]!
      }
      this.writeHead = (this.writeHead + 1) % this.capacity
      this.filled = Math.min(this.capacity, this.filled + 1)
      this.newSinceEmit += 1
      this.segmentSamples += 1

      if (this.filled === this.capacity && this.newSinceEmit >= stepSamples) {
        this.newSinceEmit %= stepSamples
        emitted.push(this.snapshot())
      }
    }
    return emitted
  }

  private validateBatch(batch: ModelSourceBatch): void {
    if (
      !Number.isInteger(batch.samples) ||
      batch.samples <= 0 ||
      !Number.isInteger(batch.channels) ||
      batch.channels <= 0
    ) {
      throw new Error('模型批次 shape 非法')
    }
    if (!Number.isFinite(batch.sampleRate) || batch.sampleRate <= 0) {
      throw new Error('模型批次采样率非法')
    }
    if (batch.channelNames.length !== batch.channels) {
      throw new Error('模型批次通道名数量与数据不一致')
    }
    if (batch.values.length !== batch.samples * batch.channels) {
      throw new Error('模型批次 Float32 长度与 shape 不一致')
    }
    if (batch.unit !== 'uV') {
      throw new Error(`模型服务仅接受原始 uV，收到 ${batch.unit || 'unknown'}`)
    }
  }

  private beginSegment(batch: ModelSourceBatch): void {
    this.sampleRate = batch.sampleRate
    this.channelNames = [...batch.channelNames]
    this.device = batch.device
    this.streamId = batch.streamId
    this.capacity = Math.round(this.windowSec * batch.sampleRate)
    this.buffers = Array.from(
      { length: batch.channels },
      () => new Float32Array(this.capacity),
    )
    this.writeHead = 0
    this.filled = 0
    this.newSinceEmit = 0
    this.segmentSamples = 0
    this.segmentCounter += 1
    const nonce =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10)
    this.segmentId = `${batch.device}-${Date.now().toString(36)}-${nonce}-${this.segmentCounter}`
  }

  /** Start a fresh segment without clearing ring buffers (after server rejections). */
  bumpSegment(): void {
    if (!this.device || !this.channelNames.length || !this.sampleRate) {
      this.reset()
      return
    }
    this.beginSegment({
      values: new Float32Array(0),
      samples: 0,
      channels: this.channelNames.length,
      sampleRate: this.sampleRate,
      channelNames: [...this.channelNames],
      unit: 'uV',
      packetLoss: this.lastPacketLoss,
      packetCount: this.lastPacketCount,
      device: this.device,
      streamId: this.streamId,
    })
    this.segmentSamples = Math.max(this.capacity, this.segmentSamples)
  }

  private snapshot(): ModelWindowPacket {
    const channels = this.buffers.length
    const payloadValues = new Float32Array(channels * this.capacity)
    const oldest = this.filled === this.capacity ? this.writeHead : 0
    for (let channel = 0; channel < channels; channel++) {
      const source = this.buffers[channel]!
      const outputOffset = channel * this.capacity
      for (let i = 0; i < this.capacity; i++) {
        payloadValues[outputOffset + i] = source[(oldest + i) % this.capacity]!
      }
    }

    this.emitSequence += 1
    const endTimeSec = this.segmentSamples / this.sampleRate
    const startTimeSec = endTimeSec - this.windowSec
    return {
      header: {
        type: 'window',
        schema_version: MODEL_PROTOCOL_VERSION,
        request_id: createProtocolId('window'),
        window_id: this.emitSequence,
        segment_id: this.segmentId,
        sample_rate: this.sampleRate,
        channel_names: [...this.channelNames],
        unit: 'uV',
        layout: 'CT',
        channels,
        samples: this.capacity,
        sample_count: this.capacity,
        start_time_sec: startTimeSec,
        end_time_sec: endTimeSec,
      },
      payload: payloadValues.buffer,
    }
  }
}
