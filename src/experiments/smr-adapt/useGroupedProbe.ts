import { useEffect, useRef, useState } from 'react'
import { currentProbeBaseline, loadProbeBaseline, recordRound, runGroupProbe, runRoundLora, trainingRequest,
  waitForProbePrediction, type ProbeRound, type ProbeBaseline, type LoraOptions } from './groupedProbe'

export type ProbeOptions = { minimumGain: number; maximumRecallDrop: number; lora?: LoraOptions }

export function useGroupedProbe(options: ProbeOptions, requireAdaptation = false) {
  const round = useRef<ProbeRound | null>(null)
  const initialRevision = useRef<string | null>(null)
  const completed = useRef(false)
  const roundOptions = useRef(options)
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [message, setMessage] = useState('')
  const [roundId, setRoundId] = useState<string | null>(null)
  const pending = useRef<{ rel: string; last: boolean; probeDone?: boolean; loraDone?: boolean; result?: string } | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  async function begin(enabled: boolean, subjectId: string, seed: number, startupSignal?: AbortSignal) {
    controller.current?.abort()
    controller.current = new AbortController()
    const signal = startupSignal ? AbortSignal.any([controller.current.signal, startupSignal]) : controller.current.signal
    round.current = null; pending.current = null; initialRevision.current = null; completed.current = false
    setBlocked(false); setMessage(''); setRoundId(null)
    if (!enabled) return
    if ([options.minimumGain, options.maximumRecallDrop].some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('接管阈值必须为 0–100 个百分点')
    }
    if (options.lora && (!Number.isInteger(options.lora.epochs) || options.lora.epochs < 1 || options.lora.epochs > 100
      || !Number.isFinite(options.lora.lr) || options.lora.lr < .000001 || options.lora.lr > .01)) {
      throw new Error('LoRA epochs 必须为 1–100 的整数，学习率必须为 0.000001–0.01')
    }
    const baseline = await currentProbeBaseline(signal)
    await waitForProbePrediction(baseline, signal)
    const result = await trainingRequest<{ round: { id: string } }>('rounds', { subjectId, seed }, signal)
    round.current = { id: result.round.id, subjectId, seed, baseline, sessions: [] }
    initialRevision.current = baseline.revision
    roundOptions.current = options
    setRoundId(result.round.id)
  }

  async function check() {
    if (!round.current) return
    const signal = controller.current!.signal
    const actual = await currentProbeBaseline(signal)
    await waitForProbePrediction({ ...round.current.baseline, revision: actual.revision, headId: actual.headId || round.current.baseline.headId }, signal)
  }

  async function finish(rel: string, last: boolean) {
    const current = round.current
    if (!current) return true
    if (pending.current?.rel !== rel) pending.current = { rel, last }
    const phase = pending.current
    const signal = controller.current!.signal
    setBusy(true); setBlocked(false)
    try {
      const stem = rel.replace(/^recordings\//, '')
      const { minimumGain, maximumRecallDrop, lora } = roundOptions.current
      if (!current.sessions.includes(stem)) {
        await recordRound(current, 'group_saved', { session: rel, model: current.baseline, last, options: roundOptions.current }, signal)
        current.sessions.push(stem)
      }
      const thresholds = { minimumGain, maximumRecallDrop }
      if (!phase.probeDone) {
        phase.result = await runGroupProbe(current, thresholds, signal, setMessage)
        phase.probeDone = true
      }
      // LoRA 选项仅对 REVE 有效 — EEGNet 每组已做完整 FT
      if (last && lora && current.baseline.modelName !== 'eegnet' && !phase.loraDone) {
        phase.result = await runRoundLora(current, thresholds, lora, signal, setMessage)
        phase.loraDone = true
      }
      const adapted = current.baseline.revision !== initialRevision.current
      if (last && (!requireAdaptation || adapted)) {
        await recordRound(current, 'complete', { model: current.baseline, sessions: current.sessions }, signal)
        completed.current = true
      }
      setMessage(phase.result + (last && requireAdaptation && !adapted
        ? '本轮还没有选出个体化模型，可追加一组采集。'
        : last ? '本轮结束，下一轮沿用已选定模型。' : '可以继续下一组。'))
      pending.current = null
      return true
    } catch (error) {
      if (signal.aborted) return false
      const detail = error instanceof Error ? error.message : String(error)
      setBlocked(true); setMessage(`组间处理未完成：${detail}。检查后可重试。`)
      await recordRound(current, 'error', { message: detail }, signal).catch(() => undefined)
      return false
    } finally { if (!signal.aborted) setBusy(false) }
  }

  async function retry() {
    if (!pending.current || !round.current || busy) return false
    setBusy(true)
    try {
      // A completed round may have been recovered from its saved training
      // results while this tab still shows the earlier load timeout.
      if (pending.current.last) {
        const saved = await trainingRequest<{ round: { entries: Array<{ type: string;
          data: { model?: ProbeBaseline; sessions?: string[] } }> } }>(`rounds/${round.current.id}`,
          undefined, controller.current!.signal)
        const completion = saved.round.entries.filter(entry => entry.type === 'complete').at(-1)?.data
        if (completion?.model && completion.sessions?.length === round.current.sessions.length
          && completion.sessions.every(stem => round.current!.sessions.includes(stem))) {
          await loadProbeBaseline(completion.model, controller.current!.signal)
          round.current.baseline = completion.model
          completed.current = true
          pending.current = null
          setBlocked(false); setBusy(false)
          setMessage('本轮数据与训练结果已保存，已恢复处理完成状态，无需重复训练。下一轮开始前检查实时 EEG。')
          return true
        }
      }
      setMessage('正在恢复本轮模型…')
      await loadProbeBaseline(round.current.baseline, controller.current!.signal)
    } catch (error) {
      setBlocked(true); setMessage(`恢复失败：${String(error)}`); setBusy(false)
      return false
    }
    return finish(pending.current.rel, pending.current.last)
  }

  function restore(saved: ProbeRound, needsProcessing: boolean, result: string, savedOptions?: ProbeOptions) {
    controller.current?.abort()
    controller.current = new AbortController()
    round.current = saved
    completed.current = false
    roundOptions.current = savedOptions ?? options
    pending.current = { rel: `recordings/${saved.sessions.at(-1)}`, last: false, probeDone: !needsProcessing, result }
    setRoundId(saved.id)
    return retry()
  }

  function interrupt(reason: string) {
    if (round.current && !completed.current) void recordRound(round.current, 'interrupted', { reason }).catch(() => undefined)
    controller.current?.abort()
    round.current = null; pending.current = null
    setBusy(false); setBlocked(false)
    if (requireAdaptation) { setRoundId(null); setMessage('') }
  }

  function adaptedModel() {
    const baseline = round.current?.baseline
    return baseline && initialRevision.current !== null && baseline.revision !== initialRevision.current ? baseline : null
  }

  return { busy, blocked, message, roundId, round, begin, check, finish, retry, restore, interrupt, adaptedModel }
}
