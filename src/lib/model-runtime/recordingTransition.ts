import { acqRuntime } from '../../acquisition/runtime'
import { sessionHub } from '../session/sessionHub'
import { SessionLogger } from '../logger'
import { sampleClock } from '../eeg/sampleClock'

/** Called under modelOperation: save first, change model, then start a separate recording. */
export async function withRecordingTransition<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const recorder = acqRuntime.recorder
  if (!recorder.recording) return action()
  const options = recorder.restartOptions
  const meta = sessionHub.boundMeta
  const previous = sessionHub.info.rel
  const logger = new SessionLogger(meta.experiment ?? 'acquisition', meta.subjectId ?? 'anon')
  logger.log('model_change_recording_end', { previous })
  const saved = await recorder.stop()
  if (saved?.error) throw new Error(`旧段保存失败，模型未切换：${saved.error}`)
  signal.throwIfAborted()
  let result: T
  try { result = await action() }
  catch (error) {
    if (signal.aborted) throw error
    throw new Error(`旧段已保存；模型切换失败，录制已停止：${error instanceof Error ? error.message : String(error)}`)
  }
  signal.throwIfAborted()
  if (!acqRuntime.streaming) throw new Error('模型已切换，旧段已保存；EEG 已停止，请重新开流并开始录制')
  try {
    // A fresh segment gets a fresh file and sample origin, even for rapid switches.
    const restart = { ...options, filenamePrefix: `${options.filenamePrefix}_model_${Date.now()}` }
    sampleClock.reset()
    await recorder.start(restart, signal)
    signal.throwIfAborted()
    sessionHub.bindMeta(meta)
    logger.log('model_change_recording_start', { previous: saved?.rel ?? previous, current: sessionHub.info.rel })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`模型已切换，旧段已保存；新段录制未成功：${error instanceof Error ? error.message : String(error)}`)
  }
  return result
}
