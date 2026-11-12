import { ensureModelService, modelServiceStatus, stopModelService } from '../../lib/model-runtime/modelServiceApi'
import { modelRuntimeHub } from '../../lib/model-runtime/modelRuntimeHub'
import { liveStepSecForReveTask } from '../../lib/model-runtime/reveTasks'

export type ProbeBaseline = { headId: string; revision: string; modelName: string; stepSec: number; windowSec: number
  /** Absolute checkpoint path reported by the EEGNet service hello. */
  checkpoint?: string }
export type ProbeRound = { id: string; subjectId: string; seed: number; sessions: string[]; baseline: ProbeBaseline }
export type LoraOptions = { epochs: number; lr: number; rank: number; alpha: number; batchSize: number; accumulationSteps: number }
export type ProbeReport = {
  skipped?: boolean; reason?: string; headId: string; baselineHeadId: string
  baselineRevision: string; modelRevision: string; validationSnapshot: string
  baseline: { balancedAccuracy: number }; metrics: { validation: { balancedAccuracy: number } }
  decision: { promote: boolean; reason: string }
}

export async function trainingRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/training/${url}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
  const result = await res.json()
  if (!res.ok || !result.ok) throw new Error(result.message || '训练接口请求失败')
  return result as T
}
export async function recordRound(round: ProbeRound, type: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  await trainingRequest(`rounds/${round.id}`, { type, data }, signal)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function currentProbeBaseline(signal: AbortSignal): Promise<ProbeBaseline> {
  const status = await modelServiceStatus(signal)
  const hello = modelRuntimeHub.snapshot.serviceHello
  if (hello?.supports_group_training === false) {
    throw new Error('当前模型的预处理与组间训练不兼容，请关闭组间自动训练后采集；推理和原始数据保存不受影响')
  }
  if (modelRuntimeHub.snapshot.status !== 'ready' || !hello?.model_revision) {
    throw new Error('模型尚未就绪，请先连接后再采集')
  }
  if (hello.model_type === 'eegnet') {
    if (!hello.checkpoint) throw new Error('EEGNet 服务未报告 checkpoint 路径，无法作为组间训练基线')
    return { headId: '', revision: hello.model_revision, modelName: 'eegnet',
      stepSec: status.stepSec ?? 0.1, windowSec: hello.window_sec ?? 2, checkpoint: hello.checkpoint }
  }
  return { headId: status.headId || status.loadedHead || '', revision: hello.model_revision,
    modelName: hello.model_name || 'reve', stepSec: status.stepSec ?? liveStepSecForReveTask('smr_control'),
    windowSec: hello.window_sec && [2, 4].includes(hello.window_sec) ? hello.window_sec : 4 }
}

export async function waitForProbePrediction(baseline: ProbeBaseline, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const snapshot = modelRuntimeHub.snapshot
    const prediction = modelRuntimeHub.latestObservation(1500)
    if (snapshot.status === 'ready' && prediction
      && prediction.prepare_latency_ms + prediction.inference_latency_ms <= baseline.stepSec * 1000) return
    await delay(200, signal)
  }
  throw new Error('模型未在 45 秒内产生符合版本和延迟要求的新预测；请检查 EEG 和模型连接')
}

export async function loadProbeBaseline(baseline: ProbeBaseline, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const result = await ensureModelService({ backend: 'reve', task: 'smr_control', headId: baseline.headId,
    stepSec: baseline.stepSec, signal })
  if (!result.running) throw new Error('模型未启动')
  modelRuntimeHub.disconnect()
  modelRuntimeHub.setEnabled(true)
  modelRuntimeHub.connect()
  // Finishing offline training must not require the participant to keep
  // streaming EEG. begin/check still require a fresh prediction before a run.
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const { status, serviceHello: hello } = modelRuntimeHub.snapshot
    if (status === 'ready' && hello?.model_revision === baseline.revision) return
    await delay(200, signal)
  }
  throw new Error('模型载入后未确认预期版本和四分类接口；已保存的数据及训练结果不受影响，可重试载入')
}

async function runJob(config: Record<string, unknown>, signal: AbortSignal): Promise<{ id: string; report: ProbeReport }> {
  const { job } = await trainingRequest<{ job: { id: string } }>('jobs', config, signal)
  try {
    const timeoutMinutes = config.kind === 'lora' ? 120 : 30
    const deadline = Date.now() + timeoutMinutes * 60 * 1000
    while (Date.now() < deadline) {
      const result = await trainingRequest<{ job: { status: string; error?: string }; report: ProbeReport }>(`jobs/${job.id}`, undefined, signal)
      if (result.job.status === 'complete') return { id: job.id, report: result.report }
      if (result.job.status !== 'running') throw new Error(result.job.error || `训练任务 ${result.job.status}`)
      await delay(1000, signal)
    }
    throw new Error(`训练任务超过 ${timeoutMinutes} 分钟`)
  } catch (error) {
    // Also cancel the child process; abandoning a browser poll must not leave a GPU job running.
    await trainingRequest(`jobs/${job.id}/cancel`, {}).catch(() => undefined)
    if (!signal.aborted) {
      // Cancellation is acknowledged before the child closes and releases the model gate.
      const until = Date.now() + 10000
      while (Date.now() < until) {
        const status = await trainingRequest<{ active?: boolean }>(`jobs/${job.id}`, undefined, signal)
        if (!status.active) break
        await delay(200, signal)
      }
    }
    throw error
  }
}

export async function runGroupProbe(round: ProbeRound, options: { minimumGain: number; maximumRecallDrop: number },
  signal: AbortSignal, progress: (message: string) => void): Promise<string> {
  if (round.baseline.modelName === 'eegnet') return runEegnetTraining(round, options, signal, progress)
  return runAdaptiveTraining(round, options, signal, progress)
}

/** recordings/.eegnet-relative weight id understood by selectModelWeight. */
function eegnetWeightId(checkpoint: string): string {
  const marker = '/.eegnet/'
  const normalized = checkpoint.replace(/\\/g, '/')
  const at = normalized.indexOf(marker)
  return `eegnet:${at >= 0 ? normalized.slice(at + marker.length) : normalized}`
}

type EegnetDecision = {
  promote: boolean; stage?: 'lp' | 'ft'; checkpoint: string; revision: string; reason: string
}
type EegnetReport = {
  decision: EegnetDecision
  stages: { lp: { validation: { balanced_accuracy: number }; test?: { balanced_accuracy: number } }
            ft: { validation: { balanced_accuracy: number }; test?: { balanced_accuracy: number } } }
}

async function loadEegnetCheckpoint(weightId: string, revision: string, stepSec: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const result = await ensureModelService({ backend: 'eegnet', weightId, stepSec, signal })
  if (!result.running) throw new Error('模型未启动')
  modelRuntimeHub.disconnect()
  modelRuntimeHub.setEnabled(true)
  modelRuntimeHub.connect()
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const { status, serviceHello: hello } = modelRuntimeHub.snapshot
    if (status === 'ready' && hello?.model_revision === revision) return
    await delay(200, signal)
  }
  throw new Error('模型载入后未确认预期版本；已保存的数据及训练结果不受影响，可重试载入')
}

/** Offline LP→FT for the EEGNet backend: inference keeps running; promote via ensure. */
async function runEegnetTraining(round: ProbeRound, options: { minimumGain: number; maximumRecallDrop: number },
  signal: AbortSignal, progress: (message: string) => void): Promise<string> {
  const stage = 'EEGNet LP→FT'
  const original = { ...round.baseline }
  const actual = await currentProbeBaseline(signal)
  if (actual.modelName !== 'eegnet' || !actual.checkpoint || actual.revision !== original.revision) {
    throw new Error('模型在本组期间被更换，停止自动接管')
  }
  progress(`${stage}：后台训练本轮累计数据（推理不间断，验证达阈值才接管）…`)
  let chosen = original
  let message = ''
  try {
    const { report } = await runJob({ kind: 'eegnet', roundId: round.id, sessions: round.sessions,
      baselineCheckpoint: original.checkpoint, seed: round.seed, ...options }, signal) as unknown as { report: EegnetReport }
    const lp = report.stages.lp.validation.balanced_accuracy
    const ft = report.stages.ft.validation.balanced_accuracy
    const test = report.stages[report.decision.stage ?? 'ft']?.test?.balanced_accuracy
    const pct = (v?: number) => v === undefined ? '—' : `${(v * 100).toFixed(1)}%`
    message = `LP 验证 ${pct(lp)} · FT 验证 ${pct(ft)} · 测试（仅报告）${pct(test)}；${report.decision.reason}`
    if (report.decision.promote) {
      progress(`${message}；正在载入选定权重…`)
      try {
        await loadEegnetCheckpoint(eegnetWeightId(report.decision.checkpoint), report.decision.revision,
          original.stepSec, signal)
        chosen = { ...original, revision: report.decision.revision, checkpoint: report.decision.checkpoint }
      } catch (error) {
        signal.throwIfAborted()
        progress('候选载入检查失败，正在恢复原模型…')
        await loadEegnetCheckpoint(eegnetWeightId(original.checkpoint!), original.revision, original.stepSec, signal)
        message = `候选未通过载入检查，已恢复原模型：${error instanceof Error ? error.message : String(error)}`
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    message = `本次训练失败，保留原模型：${error instanceof Error ? error.message : String(error)}`
    await recordRound(round, 'error', { message }, signal)
  }
  signal.throwIfAborted()
  await recordRound(round, 'model_decision', { stage: 'eegnet_lp_ft', previous: original, selected: chosen,
    message }, signal)
  round.baseline = chosen
  return `${stage}：${message}。模型已就绪。`
}

export async function runRoundLora(round: ProbeRound, options: { minimumGain: number; maximumRecallDrop: number },
  lora: LoraOptions, signal: AbortSignal, progress: (message: string) => void): Promise<string> {
  return runAdaptiveTraining(round, options, signal, progress, lora)
}

async function runAdaptiveTraining(round: ProbeRound, options: { minimumGain: number; maximumRecallDrop: number },
  signal: AbortSignal, progress: (message: string) => void, lora?: LoraOptions): Promise<string> {
  const stage = lora ? '轮末 LoRA' : '组间 probing'
  const original = { ...round.baseline }
  const actual = await currentProbeBaseline(signal)
  if (actual.headId !== original.headId || actual.revision !== original.revision) throw new Error('模型在本组期间被更换，停止自动接管')
  progress(`${stage}：释放推理模型，准备导出${lora ? '同被试历史' : '本轮累计'}数据…`)
  await stopModelService(signal)
  let chosen = original
  let message = ''
  let report: ProbeReport | undefined
  try {
    const exported = await runJob({
      kind: 'export', roundId: round.id, sessions: round.sessions, labelSource: 'trial', subjectId: 1,
      windowSec: original.windowSec,
      ...(lora ? { scope: 'history' } : {}),
    }, signal)
    progress(lora ? '轮末休息：联合训练 LoRA 与分类头，在相同历史验证快照上比较…' : '组间休息：均衡训练分类头，并在固定验证集上比较…')
    const fitted = await runJob({ kind: lora ? 'lora' : 'fit', roundId: round.id, datasetId: exported.id, splitBy: 'trial',
      headId: original.headId, baselineRevision: original.revision, modelName: original.modelName,
      seed: round.seed, device: 'auto', epochs: 100, lr: .001, ...options, ...lora }, signal)
    report = fitted.report
    if (report.skipped) message = report.reason || '有效样本不足，本次跳过训练'
    else {
      if (report.baselineRevision !== original.revision) throw new Error('评估基线版本不一致')
      const promote = report.decision.promote
      chosen = { ...original, headId: promote ? report.headId : report.baselineHeadId,
        revision: promote ? report.modelRevision : original.revision }
      message = `${report.decision.reason}。验证平衡准确率 ${(report.baseline.balancedAccuracy * 100).toFixed(1)}% → ${(report.metrics.validation.balancedAccuracy * 100).toFixed(1)}%`
    }
  } catch (error) {
    signal.throwIfAborted()
    message = `本次训练失败，恢复原模型：${error instanceof Error ? error.message : String(error)}`
    await recordRound(round, 'error', { message }, signal)
  }
  signal.throwIfAborted()
  progress(`${message}；正在载入并检查模型…`)
  try {
    await loadProbeBaseline(chosen, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (chosen.headId === original.headId) throw error
    progress('候选载入检查失败，正在恢复原模型…')
    await loadProbeBaseline(original, signal)
    chosen = original
    message = `候选未通过载入检查，已恢复原模型：${error instanceof Error ? error.message : String(error)}`
  }
  await recordRound(round, 'model_decision', { stage: lora ? 'lora' : 'probe', previous: original, selected: chosen,
    validationSnapshot: report?.validationSnapshot ?? null, message }, signal)
  round.baseline = chosen
  return `${stage}：${message}。模型已就绪。`
}
