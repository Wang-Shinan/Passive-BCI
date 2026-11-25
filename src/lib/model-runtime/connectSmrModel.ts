import { acqRuntime } from '../../acquisition/runtime'
import { liveEegHub } from '../eeg/liveHub'
import { modelRuntimeHub, modelUrlPresets } from './modelRuntimeHub'
import { ensureModelService, modelServiceStatus } from './modelServiceApi'
import { ensureGridBcigoStream } from '../../experiments/smr-grid/ensureBcigoStream'
import { smrModelAxes } from '../../experiments/smr-adapt/labels'

function checkCancelled(signal: AbortSignal): void { signal.throwIfAborted() }

/** Wait for the model handshake with a cancellable timeout. */
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
    if (acqRuntime.streaming && acqRuntime.device !== 'bcigo') {
      throw new Error('当前 EEG 来源没有新样本，请在采集调试页恢复数据流后重试')
    }
    progress('正在接入 BCIGo 原始 EEG 数据流…')
    await ensureGridBcigoStream(signal)
    checkCancelled(signal)
  }
  checkCancelled(signal)
  progress('模型与 EEG 来源已接入')
}

/** Attach to the applied model for grouped recording, or start the SMR default when idle. */
export async function connectGroupedSmrModel(
  signal: AbortSignal, progress: (message: string) => void, headId?: string, appliedOnly = false,
): Promise<void> {
  progress('正在连接当前 SMR 模型…')
  const presets = modelUrlPresets()
  const proxyUrl = presets.find(item => item.id === 'proxy')!.url
  if (headId || presets.some(item => item.url === modelRuntimeHub.snapshot.url)) {
    const status = await modelServiceStatus(signal)
    checkCancelled(signal)
    if (headId || (!status.running && !status.starting)) {
      if (appliedOnly) throw new Error('请先在模型设置应用左手、右手、舌头、放松四分类模型，再开始光标控制。')
      progress(headId ? '正在应用所选 SMR 分类头…' : '正在启动默认 SMR 模型…')
      await ensureModelService({ backend: 'reve', task: 'smr_control', headId, stepSec: 0.1, signal })
    }
    if (headId) await modelRuntimeHub.setUrl(proxyUrl)
  }
  checkCancelled(signal)
  const previous = modelRuntimeHub.snapshot
  if (!previous.enabled) modelRuntimeHub.setEnabled(true)
  else if (previous.status !== 'ready' && previous.status !== 'connecting') modelRuntimeHub.connect()
  await waitFor(() => modelRuntimeHub.snapshot.status === 'ready', signal, 15000,
    () => modelRuntimeHub.snapshot.lastError || '模型握手超时，请确认服务正在运行')
  const hello = modelRuntimeHub.snapshot.serviceHello
  const names = hello?.class_names
  if (!names || !smrModelAxes(names)) {
    throw new Error(`当前模型类别为 ${names?.join(' / ') || '未报告'}。请选择四分类 SMR 模型、左右二分类模型或舌头／放松二分类模型。`)
  }
  if (!(acqRuntime.streaming && liveEegHub.isFresh())) {
    throw new Error('请先在采集调试页开流，分组采集需要可录制的原始 EEG。')
  }
  checkCancelled(signal)
  progress(`已接入当前 ${names.length} 类 SMR 模型与原始 EEG`)
}
