import type { ModelServiceBackend, ModelServiceEnsureResult, ModelHeadOption } from './modelServiceTypes'
export type { ModelServiceBackend, ModelServiceEnsureResult, ModelHeadOption, GazeModelReport } from './modelServiceTypes'
import { acqRuntime } from '../../acquisition/runtime'
import { sessionHub } from '../session/sessionHub'
import { modelOperation } from './modelOperation'
import { preferredModelHead, saveModelHeadPreference } from './modelHeadPreference'
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
    backend: value.backend, headId: value.headId, configurationKey: value.configurationKey, modelRevision: value.modelRevision,
    gazeReport: value.gazeReport })
  if (key === appliedKey) return
  appliedKey = key; appliedModel = value
  for (const fn of appliedListeners) fn()
}

let runtimeControl: { suspend: () => void; disable: () => void } | null = null
export function registerModelRuntimeControl(control: NonNullable<typeof runtimeControl>): void { runtimeControl = control }
export function modelConfigurationLocked(): boolean { return acqRuntime.recorder.recording || sessionHub.active }
export function selectModelHeadPreference(task: string, id: string): void {
  if (modelConfigurationLocked() || modelOperation.busy) throw new Error('请先结束录制和当前模型操作，再选择线性头')
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
  if (epoch === mutationEpoch && request === statusRequest && !modelOperation.busy) publishAppliedModel(result)
  return result
}

export async function ensureModelService(options?: {
  headId?: string
  backend?: ModelServiceBackend
  task?: string
  stepSec?: number
  force?: boolean
  signal?: AbortSignal
}): Promise<ModelServiceEnsureResult> {
  if (modelConfigurationLocked()) throw new Error('录制期间不能启动、替换模型或改变步长；请先结束录制')
  const headId = options?.headId ?? preferredModelHead(options?.task)
  let epoch = mutationEpoch
  const result = await modelOperation.run(async signal => {
    epoch = ++mutationEpoch
    if (modelConfigurationLocked()) throw new Error('录制已开始，取消模型切换')
    runtimeControl?.suspend()
    const res = await fetch('/api/model-service/ensure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: options?.backend ?? 'reve', task: options?.task,
        headId: options?.backend === 'mock' ? undefined : headId,
        stepSec: options?.stepSec, force: options?.force === true }), signal,
    })
    const body = await parseResult(res)
    if (!res.ok || !body.ok) throw new Error(body.message || '无法启动模型服务')
    return body
  }, options?.signal)
  if (epoch !== mutationEpoch) throw new DOMException('模型操作已取消', 'AbortError')
  publishAppliedModel(result)
  return result
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
