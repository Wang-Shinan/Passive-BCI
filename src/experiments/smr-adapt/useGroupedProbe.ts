import { useEffect, useRef, useState } from 'react'
import { currentProbeBaseline, loadProbeBaseline, recordRound, runGroupProbe, runRoundLora, trainingRequest,
  waitForProbePrediction, type ProbeRound, type LoraOptions } from './groupedProbe'

export function useGroupedProbe(options: { minimumGain: number; maximumRecallDrop: number; lora?: LoraOptions }) {
  const round = useRef<ProbeRound | null>(null)
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [message, setMessage] = useState('')
  const [roundId, setRoundId] = useState<string | null>(null)
  const pending = useRef<{ rel: string; last: boolean; probeDone?: boolean; loraDone?: boolean; result?: string } | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  async function begin(enabled: boolean, subjectId: string, seed: number) {
    controller.current?.abort()
    controller.current = new AbortController()
    const signal = controller.current.signal
    round.current = null; pending.current = null
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
    setRoundId(result.round.id)
  }

  async function check() {
    if (!round.current) return
    const signal = controller.current!.signal
    const actual = await currentProbeBaseline(signal)
    if (actual.headId !== round.current.baseline.headId || actual.revision !== round.current.baseline.revision) {
      throw new Error('当前模型与本轮记录不一致，请恢复本轮模型后继续')
    }
    await waitForProbePrediction(round.current.baseline, signal)
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
      if (!current.sessions.includes(stem)) {
        await recordRound(current, 'group_saved', { session: rel, model: current.baseline, last }, signal)
        current.sessions.push(stem)
      }
      const thresholds = { minimumGain: options.minimumGain, maximumRecallDrop: options.maximumRecallDrop }
      if (!phase.probeDone) {
        phase.result = await runGroupProbe(current, thresholds, signal, setMessage)
        phase.probeDone = true
      }
      if (last && options.lora && !phase.loraDone) {
        phase.result = await runRoundLora(current, thresholds, options.lora, signal, setMessage)
        phase.loraDone = true
      }
      if (last) await recordRound(current, 'complete', { model: current.baseline, sessions: current.sessions }, signal)
      setMessage(phase.result + (last ? '本轮结束，下一轮沿用已选定模型。' : '可以继续下一组。'))
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
      setMessage('正在恢复本轮模型…')
      await loadProbeBaseline(round.current.baseline, controller.current!.signal)
    } catch (error) {
      setMessage(`恢复失败：${String(error)}`); setBusy(false)
      return false
    }
    return finish(pending.current.rel, pending.current.last)
  }

  function interrupt(reason: string) {
    if (round.current) void recordRound(round.current, 'interrupted', { reason }).catch(() => undefined)
    controller.current?.abort()
    round.current = null; pending.current = null
    setBusy(false); setBlocked(false)
  }

  return { busy, blocked, message, roundId, round, begin, check, finish, retry, interrupt }
}
