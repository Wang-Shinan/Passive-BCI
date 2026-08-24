/** Dev-server helpers to auto-start the local NCC model WebSocket. */

export type ModelServiceBackend = 'reve' | 'mock'

export type ModelServiceEnsureResult = {
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
