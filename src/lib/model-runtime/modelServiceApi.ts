import type { ModelServiceBackend, ModelServiceEnsureResult, ModelHeadOption } from './modelServiceTypes'
export type { ModelServiceBackend, ModelServiceEnsureResult, ModelHeadOption, GazeModelReport } from './modelServiceTypes'
import { acqRuntime } from '../../acquisition/runtime'
import { sessionHub } from '../session/sessionHub'
import { SessionLogger } from '../logger'
import { withRecordingTransition } from './recordingTransition'
import { modelOperation } from './modelOperation'
import { currentModelSubject, preferredModelHead, saveModelHeadPreference } from './modelHeadPreference'
import { loadReveFilterSettings, sameReveCustomFilter, type ReveCustomFilter, type ReveFilterMode, type ReveFilterSettings } from './reveFilter'
export { preferredModelHead, subscribeModelHeadPreference } from './modelHeadPreference'

let appliedModel: ModelServiceEnsureResult | null = null
let appliedKey = ''
let mutationEpoch = 0
let statusRequest = 0
const appliedListeners = new Set<() => void>()
export const getAppliedModel = () => appliedModel
export function subscribeAppliedModel(fn: () => void): () => void { appliedListeners.add(fn); return () => { appliedListeners.delete(fn) } }
function publishAppliedModel(value: ModelServiceEnsureResult | null): void {
  const key = JSON.stringify(value && { running: value.running, starting: value.starting, task: value.task,
    owned: value.owned, pid: value.pid, loadedHead: value.loadedHead,
    backend: value.backend, weightId: value.weightId, headId: value.headId, configurationKey: value.configurationKey, modelRevision: value.modelRevision,
    gazeReport: value.gazeReport, reveFilterMode: value.reveFilterMode, reveCustomFilter: value.reveCustomFilter })
  if (key === appliedKey) return
  appliedKey = key; appliedModel = value
  for (const fn of appliedListeners) fn()
}

let runtimeControl: { suspend: () => void; disable: () => void; prepareManaged?: () => void } | null = null
export function registerModelRuntimeControl(control: NonNullable<typeof runtimeControl>): void { runtimeControl = control }
export function modelConfigurationLocked(): boolean { return acqRuntime.recorder.recording || sessionHub.active }
export function selectModelHeadPreference(task: string, id: string): void {
  // Selection is desired state; applying goes through ensure, which supersedes in-flight ops.
  saveModelHeadPreference(task, id)
}

/** Dev-server helpers to auto-start the local NCC model WebSocket. */


async function parseResult(res: Response): Promise<ModelServiceEnsureResult> {
  let body: ModelServiceEnsureResult
  try {
    body = (await res.json()) as ModelServiceEnsureResult
  } catch {
    throw new Error(`模型服务接口无响应（HTTP ${res.status}）。请确认正在 npm run dev。`)
  }
  return body
}

export async function modelServiceStatus(
  signal?: AbortSignal,
): Promise<ModelServiceEnsureResult> {
  const epoch = mutationEpoch, request = ++statusRequest
  const res = await fetch('/api/model-service/status', { signal })
  const result = await parseResult(res)
  if (epoch === mutationEpoch && request === statusRequest) publishAppliedModel(result)
  return result
}

export async function ensureModelService(options?: {
  headId?: string
  weightId?: string
  eegnetChannels?: number
  eegnetSeed?: number
  backend?: ModelServiceBackend
  task?: string
  stepSec?: number
  windowSec?: number
  reveFilterMode?: ReveFilterMode
  reveCustomFilter?: ReveCustomFilter
  force?: boolean
  signal?: AbortSignal
}): Promise<ModelServiceEnsureResult> {
  const subjectId = currentModelSubject()
  const headId = options?.headId ?? preferredModelHead(options?.task, subjectId)
  const backend = options?.backend ?? 'reve'
  const preferredFilter = loadReveFilterSettings()
  const reveFilterMode = backend === 'reve' ? options?.reveFilterMode ?? preferredFilter.reveFilterMode : undefined
  const reveCustomFilter = reveFilterMode === 'custom'
    ? options?.reveCustomFilter ?? preferredFilter.reveCustomFilter : undefined
  // Flex Ver2 selects 16 source channels in the browser, including for SDK capture.
  const sdkSource = backend === 'reve' && acqRuntime.device === 'omni' &&
    acqRuntime.omniLink === 'sdk' && !acqRuntime.omniFlexVer2.enabled
  if (sdkSource && !acqRuntime.omni) throw new Error('请先在采集调试页连接 SDK BLE 设备')
  let epoch = mutationEpoch
  // Latest control wins: supersede any in-flight operation instead of rejecting this one.
  if (modelOperation.busy) modelOperation.cancel()
  const result = await modelOperation.run(async signal => {
    epoch = ++mutationEpoch
    return withRecordingTransition(async () => {
    runtimeControl?.suspend()
    runtimeControl?.prepareManaged?.()
    const res = await fetch('/api/model-service/ensure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend, task: options?.task,
        headId: backend === 'reve' ? headId : undefined, reveFilterMode, reveCustomFilter,
        weightId: options?.weightId, eegnetChannels: options?.eegnetChannels, eegnetSeed: options?.eegnetSeed,
        ...(sdkSource ? { omniSource: { endpoint: acqRuntime.omniSdkEndpoint, deviceType: acqRuntime.omniSdkDeviceType, channelNames: acqRuntime.omniSdkChannelNames,
          electrodeNames: acqRuntime.omniElectrodeNames, electrodePositions: acqRuntime.omniElectrodePositions } } : {}),
        stepSec: options?.stepSec, windowSec: options?.windowSec, force: options?.force === true }), signal,
    })
    const body = await parseResult(res)
    if (!res.ok || !body.ok) throw new Error(body.message || '无法启动模型服务')
    if (backend === 'reve' && headId && body.headId !== headId) {
      throw new Error(`模型服务没有确认载入指定分类头 ${headId}`)
    }
    signal.throwIfAborted()
    publishAppliedModel(body)
    return body
    }, signal)
  }, options?.signal)
  if (epoch !== mutationEpoch) throw new DOMException('模型操作已取消', 'AbortError')
  publishAppliedModel(result)
  if (options?.task === 'smr_control' && (options.backend ?? 'reve') === 'reve') {
    try { saveModelHeadPreference(options.task, headId, subjectId) }
    catch (error) { console.warn(error) }
  }
  return result
}

/** Reapply the shared filter to a running managed REVE using its current launch configuration. */
export async function applyModelInputFilter(settings: ReveFilterSettings, onApplied: () => void): Promise<void> {
  let current
  try { current = await modelServiceStatus() }
  catch (error) {
    if (appliedModel?.running && appliedModel.owned && appliedModel.backend === 'reve') throw error
    onApplied()
    return
  }
  if ((!current.running && !current.starting) || !current.owned || current.backend !== 'reve') {
    onApplied()
    return
  }
  const { reveFilterMode } = settings
  const reveCustomFilter = reveFilterMode === 'custom' ? settings.reveCustomFilter : undefined
  if (current.reveFilterMode === reveFilterMode && sameReveCustomFilter(current.reveCustomFilter, reveCustomFilter)) {
    onApplied()
    return
  }
  await modelOperation.run(async signal => {
    const epoch = ++mutationEpoch
    const response = await fetch('/api/model-service/filter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ reveFilterMode, reveCustomFilter }),
    })
    const result = await parseResult(response)
    if (!response.ok || !result.ok) throw new Error(result.message || '无法应用输入滤波')
    signal.throwIfAborted()
    if (epoch === mutationEpoch) publishAppliedModel(result)
    onApplied()
    if (sessionHub.active) {
      const meta = sessionHub.boundMeta
      const logger = new SessionLogger(meta.experiment ?? 'acquisition', meta.subjectId ?? 'anon')
      logger.log('reve_filter_changed', { reveFilterMode, reveCustomFilter })
    }
  })
}

/** Emergency stop is allowed during recording, but is recorded as an interruption. */
export async function stopModelService(signal?: AbortSignal): Promise<ModelServiceEnsureResult> {
  mutationEpoch++
  modelOperation.cancel()
  runtimeControl?.disable()
  publishAppliedModel(null)
  return modelOperation.run(async stopSignal => {
    const res = await fetch('/api/model-service/stop', { method: 'POST', signal: stopSignal })
    const body = await parseResult(res)
    if (!res.ok || !body.ok) throw new Error(body.message || '停止模型失败')
    return body
  }, signal)
}


export async function fetchModelHeads(signal?: AbortSignal): Promise<ModelHeadOption[]> {
  const response = await fetch('/api/model-service/heads', { signal })
  const body = await response.json() as { ok: boolean; heads: ModelHeadOption[]; message?: string }
  if (!response.ok || !body.ok) throw new Error(body.message || '读取线性头失败')
  return body.heads
}
