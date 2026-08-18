import { acqRuntime } from '../../acquisition/runtime'
import { CHANNEL_NAMES, CHANNELS, FRAME_BYTES, FS } from '../../acquisition/protocol/constants'
import { formatRecordBytes } from '../../acquisition/session/recorder'
import { liveEegHub } from '../eeg/liveHub'
import { sessionHub } from './sessionHub'

export type RecordControlResult = {
  ok: boolean
  message: string
  rel?: string
  sink?: string
}

function safeSubject(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 24) || 'Sxx'
}

export function recorderIsActive(): boolean {
  return acqRuntime.recorder.recording
}

export function recorderBytes(): number {
  return acqRuntime.recorder.byteLength
}

export function canStartExperimentRecording(): boolean {
  if (acqRuntime.status === 'demo' || liveEegHub.meta.device === 'demo') return false
  return acqRuntime.streaming && liveEegHub.isFresh()
}

export async function startExperimentRecording(opts: {
  experiment: string
  subjectId: string
  seed?: number
}): Promise<RecordControlResult> {
  if (acqRuntime.status === 'demo' || liveEegHub.meta.device === 'demo') {
    return { ok: false, message: '演示波形不会写入会话库' }
  }
  if (!acqRuntime.streaming || !liveEegHub.isFresh()) {
    return { ok: false, message: '请先在采集页连接设备并点「开始采集」' }
  }
  if (acqRuntime.recorder.recording) {
    sessionHub.bindMeta({
      experiment: opts.experiment,
      subjectId: opts.subjectId,
      game: opts.experiment,
      seed: opts.seed,
    })
    return {
      ok: true,
      message: '已在录制中，本局事件会写入当前会话',
      rel: sessionHub.info.rel ?? undefined,
      sink: acqRuntime.recorder.sinkKind ?? undefined,
    }
  }

  const device = liveEegHub.meta.device || acqRuntime.device
  if (!device) {
    return { ok: false, message: '当前没有可用的 EEG 设备' }
  }
  const names = liveEegHub.meta.channelNames
  const meta =
    device === 'omni'
      ? {
          device: 'omni',
          format: 'ads1299-frame',
          frameBytes: FRAME_BYTES,
          sampleRate: FS,
          channels: CHANNELS,
          channelNames: names.length ? names : [...CHANNEL_NAMES],
        }
      : {
          device,
          format: 'float32-le-interleaved',
          dtype: 'float32',
          endian: 'le',
          layout: 'sample-major',
          unit: 'uV',
          sampleRate: liveEegHub.meta.sampleRate,
          channels: names.length,
          channelNames: names,
        }
  const sink = await acqRuntime.recorder.start({
    filenamePrefix: `${device}_${opts.experiment}_${safeSubject(opts.subjectId)}`,
    meta,
  })
  sessionHub.bindMeta({
    experiment: opts.experiment,
    subjectId: opts.subjectId,
    game: opts.experiment,
    seed: opts.seed,
  })
  return {
    ok: true,
    message:
      sink === 'disk' ? '已开始写入会话库' : '开发落盘不可用，停止时将下载 BIN（无 events/context）',
    rel: sessionHub.info.rel ?? undefined,
    sink,
  }
}

export async function stopExperimentRecording(): Promise<RecordControlResult> {
  if (!acqRuntime.recorder.recording) {
    return { ok: false, message: '当前没有进行中的录制' }
  }
  const saved = await acqRuntime.recorder.stop()
  if (!saved) return { ok: true, message: '本局没有 EEG 样本，未保留目录' }
  const where = saved.rel ?? saved.name
  return {
    ok: true,
    message: `已保存 ${where}（${formatRecordBytes(saved.bytes)}）`,
    rel: saved.rel,
  }
}

export async function rollExperimentRecording(opts: {
  experiment: string
  subjectId: string
  seed?: number
}): Promise<RecordControlResult> {
  if (acqRuntime.recorder.recording) {
    const stopped = await stopExperimentRecording()
    if (!stopped.ok) return stopped
  }
  return startExperimentRecording(opts)
}
