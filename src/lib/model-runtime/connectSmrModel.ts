import { acqRuntime } from '../../acquisition/runtime'
import { liveEegHub } from '../eeg/liveHub'
import { modelRuntimeHub, modelUrlPresets } from './modelRuntimeHub'
import { ensureModelService, modelServiceStatus } from './modelServiceApi'
import { ensureGridBcigoStream } from '../../experiments/smr-grid/ensureBcigoStream'

function checkCancelled(signal: AbortSignal): void { signal.throwIfAborted() }

/** Await actual readiness, not just an open socket/bridge hello. Every wait is cancellable. */
async function waitFor(check: () => boolean, signal: AbortSignal, timeoutMs: number, message: () => string): Promise<void> {
  checkCancelled(signal)
  if (check()) return
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearInterval(timer); clearTimeout(deadline); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(signal.reason ?? new DOMException('已取消', 'AbortError'))
    const timer = setInterval(() => { if (check()) finish() }, 100)
    const deadline = setTimeout(() => finish(new Error(message())), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
  })
}

import { knownS04Revision } from './subjectModels'
export { S04_HEAD } from './subjectModels'

export async function connectSmrModel(signal: AbortSignal, progress: (message: string) => void, headId?: string): Promise<void> {
  progress('正在检查现有模型服务…')
  const status = await modelServiceStatus(signal)
  checkCancelled(signal)
  if (!status.ok) throw new Error(status.message || '无法读取模型服务状态')
  const url = modelUrlPresets().find(item => item.id === 'proxy')!.url
  const requestedRevision = knownS04Revision(headId)
  const attach = () => {
    const previous = modelRuntimeHub.snapshot
    modelRuntimeHub.setUrl(url)
    if (modelRuntimeHub.snapshot.url !== url) throw new Error('当前模型配置被锁定，无法连接现有模型地址')
    if (!previous.enabled) modelRuntimeHub.setEnabled(true)
    else if (previous.url === url && previous.status !== 'ready') modelRuntimeHub.connect()
  }
  // Read the socket that is already serving before deciding to replace it.
  if (status.running && modelRuntimeHub.snapshot.status !== 'ready') {
    progress('正在连接模型并核对四分类标签…')
    attach()
    await waitFor(() => modelRuntimeHub.snapshot.status === 'ready', signal, 15000,
      () => modelRuntimeHub.snapshot.lastError || '模型握手超时，请检查模型服务')
  }
  const current = modelRuntimeHub.snapshot
  // A matching live revision is the same head, even when status has no filename.
  const liveMatch = requestedRevision !== undefined && current.status === 'ready' && current.url === url &&
    current.serviceHello?.model_revision === requestedRevision
  const knownS04 = liveMatch || (requestedRevision !== undefined && !status.headId && status.modelRevision === requestedRevision)
  let expectedRevision = requestedRevision ?? status.modelRevision
  if (knownS04) expectedRevision = requestedRevision
  // An external listener is already the model socket. Do not try to take its port.
  const externalService = status.running && status.owned === false
  if (!externalService && (!status.running || (headId !== undefined && (status.headId || '') !== headId && !knownS04))) {
    progress(headId ? '正在加载选中的个体化 SMR 模型…' : '正在启动已配置的 SMR 模型…')
    const selected = await ensureModelService({ backend: 'reve', task: 'smr_control', ...(headId !== undefined ? { headId } : {}), stepSec: 0.1, signal })
    expectedRevision = requestedRevision ?? selected.modelRevision
    if (headId && selected.headId !== headId && !expectedRevision) throw new Error('模型服务未应用所选分类头，请在托管该模型的网站中连接')
    checkCancelled(signal)
  }
  // Change weights only when a head is explicitly selected; never use force to take over an external process.
  if (modelRuntimeHub.snapshot.status !== 'ready') progress('正在连接模型并核对四分类标签…')
  attach()
  await waitFor(() => modelRuntimeHub.snapshot.status === 'ready', signal, 15000,
    () => modelRuntimeHub.snapshot.lastError || '模型握手超时，请检查模型服务')
  const hello = modelRuntimeHub.snapshot.serviceHello
  if (!hello) throw new Error('模型握手未返回服务信息')
  if (hello.input_source !== 'omni-sdk' && !(acqRuntime.streaming && liveEegHub.isFresh())) {
    // BCIGo is the device used in this workspace. Other already-active sources are reused above.
    // Its bridge is exclusive, so never take over another tab's active recording.
    const response = await fetch('/api/record/active', { signal })
    const recording = await response.json() as { ok?: boolean; id?: string | null }
    checkCancelled(signal)
    if (!response.ok || !recording.ok) throw new Error('无法确认采集状态，请稍后重试')
    if (recording.id) throw new Error('其他页面正在录制 EEG；请在原采集页面结束并保存录制，再连接当前页面')
    if (acqRuntime.streaming && acqRuntime.device !== 'bcigo') {
      throw new Error('当前 EEG 来源没有新样本，请在采集调试页恢复数据流后重试')
    }
    progress('正在接入 BCIGo 原始 EEG 数据流…')
    await ensureGridBcigoStream(signal)
    checkCancelled(signal)
  }
  progress('正在等待 EEG 窗口和首个新预测…')
  const previousId = modelRuntimeHub.snapshot.latestPrediction?.observation_id
  await waitFor(() => {
    const snapshot = modelRuntimeHub.snapshot
    const prediction = snapshot.latestPrediction
    return snapshot.status === 'ready' && Boolean(prediction && prediction.observation_id !== previousId &&
      performance.now() - prediction.received_at_ms < 1500)
  }, signal, 20000, () => `模型已连接，但未收到新预测。${modelRuntimeHub.snapshot.lastError || modelRuntimeHub.snapshot.sourceDetail}`)
  progress('已接入现有模型 · 正在接收 EEG 四分类预测')
}

const EEGNET_WS = 'ws://127.0.0.1:8773/v1/model'
const SMR_CLASS_NAMES = 'left_hand,right_hand,tongue,rest'

/** Grouped SMR acquisition uses the random EEGNet, not the REVE service. */
export async function connectEegnetSmr(signal: AbortSignal, progress: (message: string) => void): Promise<void> {
  progress('正在连接随机初始化 EEGNet…')
  modelRuntimeHub.setUrl(EEGNET_WS)
  if (modelRuntimeHub.snapshot.url !== EEGNET_WS) throw new Error('当前模型地址被锁定，无法连接 EEGNet')
  const previous = modelRuntimeHub.snapshot
  if (!previous.enabled) modelRuntimeHub.setEnabled(true)
  else if (previous.status !== 'ready') modelRuntimeHub.connect()
  await waitFor(() => modelRuntimeHub.snapshot.status === 'ready', signal, 15000,
    () => modelRuntimeHub.snapshot.lastError || 'EEGNet 握手超时，请确认 8773 上的服务仍在运行')
  const hello = modelRuntimeHub.snapshot.serviceHello
  if (hello?.model_type !== 'eegnet' || hello.class_names?.join(',') !== SMR_CLASS_NAMES) {
    throw new Error(`8773 上的模型不是四分类 EEGNet：${hello?.class_names?.join(' / ') || '未报告类别'}`)
  }
  if (!(acqRuntime.streaming && liveEegHub.isFresh())) {
    throw new Error('EEGNet 已连接，但没有可录制的原始 EEG。请先在采集页开流。')
  }
  progress('正在等待 EEG 窗口和首个新预测…')
  const previousId = modelRuntimeHub.snapshot.latestPrediction?.observation_id
  await waitFor(() => {
    const prediction = modelRuntimeHub.snapshot.latestPrediction
    return modelRuntimeHub.snapshot.status === 'ready' && Boolean(prediction && prediction.observation_id !== previousId &&
      performance.now() - prediction.received_at_ms < 1500)
  }, signal, 20000, () => `EEGNet 已连接，但未收到新预测。${modelRuntimeHub.snapshot.lastError || modelRuntimeHub.snapshot.sourceDetail}`)
  progress('已接入随机初始化 EEGNet · 左手 / 右手 / 舌头 / 休息')
}
