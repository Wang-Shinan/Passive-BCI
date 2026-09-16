/** Dev-server helpers to auto-start the local NCC model WebSocket. */

export type ModelServiceBackend = 'reve' | 'mock'

export function preferredModelHead(task = 'passive_rating'): string {
  if (task === 'gaze_smr') return ''
  try {
    const value = JSON.parse(localStorage.getItem('passive-bci.model-heads') || '{}')?.[task]
    return typeof value === 'string' ? value : ''
  } catch { return '' }
}

export type ModelServiceEnsureResult = {
  headId?: string | null
  loadedHead?: string | null
  ok: boolean
  backend: ModelServiceBackend | null
  task?: string | null
  stepSec?: number | null
  port: number
  running: boolean
  owned: boolean
  pid: number | null
  alreadyRunning: boolean
  starting: boolean
  message?: string
  logTail?: string
}

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
  const res = await fetch('/api/model-service/status', { signal })
  return parseResult(res)
}

export async function ensureModelService(options?: {
  headId?: string
  backend?: ModelServiceBackend
  task?: string
  stepSec?: number
  force?: boolean
  signal?: AbortSignal
}): Promise<ModelServiceEnsureResult> {
  const res = await fetch('/api/model-service/ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      backend: options?.backend ?? 'reve',
      task: options?.task,
      // Gaze collection reads a fixed active report, so it must launch that exact head.
      headId: options?.backend === 'mock' ? undefined : options?.task === 'gaze_smr' ? '' : options?.headId ?? preferredModelHead(options?.task),
      stepSec: options?.stepSec,
      force: options?.force === true,
    }),
    signal: options?.signal,
  })
  const body = await parseResult(res)
  if (!body.ok) {
    throw new Error(body.message || '无法启动模型服务')
  }
  return body
}

export async function stopModelService(signal?: AbortSignal): Promise<ModelServiceEnsureResult> {
  const res = await fetch('/api/model-service/stop', { method: 'POST', signal })
  return parseResult(res)
}

export type ModelHeadOption = {
  trainedAt?: string | null; updatedAt?: string | null
  id: string; name: string; task: string | null; encoderId: string | null
  classes: number | null; available: boolean; reason: string
}

export async function fetchModelHeads(signal?: AbortSignal): Promise<ModelHeadOption[]> {
  const response = await fetch('/api/model-service/heads', { signal })
  const body = await response.json() as { ok: boolean; heads: ModelHeadOption[]; message?: string }
  if (!response.ok || !body.ok) throw new Error(body.message || '读取线性头失败')
  return body.heads
}
