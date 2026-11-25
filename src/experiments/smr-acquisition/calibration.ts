import { SessionLogger } from '../../lib/logger'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { sampleClock } from '../../lib/eeg/sampleClock'
import { canStartExperimentRecording, recorderIsActive, startExperimentRecording, stopExperimentRecording } from '../../lib/session/recordControl'
import { sessionHub } from '../../lib/session/sessionHub'
import { SMR_IMAGERY_SCHEMA, SMR_TARGET_CLASSES, TONGUE_ACTION, TONGUE_CUE } from '../smr-adapt/labels'
import { smrTrialSeconds } from './trialTiming'
import { buildTrials, groupedPlan, type TrialRecord } from '../smr-adapt/engine'
import type { ProbeRound } from '../smr-adapt/groupedProbe'

export const cueText = { left: '左手开合', right: '右手开合', up: TONGUE_CUE, down: '静坐放松' } as const
type Target = keyof typeof cueText
export const calibrationGroupSize = 20
export type CalibrationBlock = TrialRecord[]
export type Stimulus = { phase: 'prepare' | 'cue' | 'imagery' | 'recover'; target: Target }

export function calibrationPlan(rounds: number, seed: number): CalibrationBlock[] {
  const trials = buildTrials(groupedPlan(rounds, calibrationGroupSize), seed)
  return Array.from({ length: rounds }, (_, i) => trials.slice(i * calibrationGroupSize, (i + 1) * calibrationGroupSize))
}

function hold(ms: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(id); reject(signal.reason) }
    const id = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function collectBlock(block: CalibrationBlock, subjectId: string, seed: number, preview: boolean,
  round: ProbeRound | null, signal: AbortSignal, present: (stimulus: Stimulus) => Promise<void>) {
  const experiment = 'smr-adapt'
  const logger = preview ? null : new SessionLogger(experiment, subjectId)
  const tongueAction = TONGUE_ACTION
  const meta = { protocol: 'smr-guided-calibration-v2', live: !preview, seed, run: block[0].run,
    roundId: round?.id, model: round?.baseline, imagerySchema: SMR_IMAGERY_SCHEMA, mapping: SMR_TARGET_CLASSES }
  let file: string | undefined
  let index = 0
  signal.throwIfAborted()
  try {
    if (!preview) {
      if (!canStartExperimentRecording()) throw new Error('请先在采集页接入实时 EEG，再开始采集。')
      if (recorderIsActive()) throw new Error('已有会话正在录制，请先保存该会话。')
      const result = await startExperimentRecording({ experiment, subjectId, seed, tongueAction })
      if (!result.ok || result.sink !== 'disk' || !result.rel) {
        if (result.ok) await stopExperimentRecording({ interrupted: true, interruptionReason: '没有可写入事件的磁盘会话' })
        throw new Error('启动录制失败：' + result.message)
      }
      file = result.rel
    }
    signal.throwIfAborted()
    logger?.log('session_start', { ...meta, targets: block.map(trial => trial.target), tongueAction })
    logger?.log('group_start', { ...meta, tongueAction })
    for (const { target, task, index: trialIndex } of block) {
      const fields = { ...meta, index: trialIndex, target, task, className: SMR_TARGET_CLASSES[target],
        ...(target === 'up' ? { tongueAction, cueText: TONGUE_CUE } : {}) }
      async function show(phase: Stimulus['phase']) {
        signal.throwIfAborted()
        if (!preview && (!liveEegHub.isFresh() || !recorderIsActive() || sessionHub.info.rel !== file)) {
          throw new Error('EEG 或录制已中断')
        }
        await present({ phase, target })
        signal.throwIfAborted()
      }
      await show('prepare')
      await hold(smrTrialSeconds.prepare * 1000, signal)
      await show('cue')
      logger?.log('cue', fields)
      await hold(smrTrialSeconds.cue * 1000, signal)
      await show('imagery')
      const onset = sampleClock.snapshot()
      logger?.log('feedback_start', { ...fields, phase: 'imagery_start' })
      await hold(smrTrialSeconds.imagery * 1000, signal)
      await show('recover')
      const end = sampleClock.snapshot()
      if (!preview && (!onset || !end || end.sampleIndex <= onset.sampleIndex || end.sampleRate !== onset.sampleRate)) {
        throw new Error('想象段缺少有效的 EEG 样本边界')
      }
      logger?.log('trial', { ...fields, phase: 'imagery_end', valid: true, outcome: 'completed',
        imageryStartSample: onset?.sampleIndex, imageryEndSample: end?.sampleIndex,
        feedbackSec: onset && end ? (end.sampleIndex - onset.sampleIndex) / onset.sampleRate : smrTrialSeconds.imagery })
      index++
      await hold(smrTrialSeconds.recover * 1000, signal)
    }
    logger?.log('group_end', { ...meta, complete: true, count: index })
    if (file) {
      const result = await stopExperimentRecording()
      if (!result.ok || result.rel !== file) throw new Error('未确认本轮已保存：' + result.message)
    }
    return file
  } catch (error) {
    if (file && recorderIsActive() && sessionHub.info.rel === file) {
      const reason = String(error)
      logger?.log('group_interrupted', { ...meta, index, complete: false, reason })
      const saved = await stopExperimentRecording({ interrupted: true, interruptionReason: reason })
      if (!saved.ok) throw new Error(reason + '；' + saved.message)
    }
    throw error
  }
}
