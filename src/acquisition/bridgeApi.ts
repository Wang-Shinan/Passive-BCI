/** Dev-server helpers to auto-start local acquisition bridges. */

export type BridgeName = 'bcigo' | 'neuracle'

export interface BridgeEnsureResult {
  ok: boolean
  name: BridgeName
  port: number
  running: boolean
  owned: boolean
  pid: number | null
  alreadyRunning: boolean
  message?: string
}

export async function ensureBridge(name: BridgeName): Promise<BridgeEnsureResult> {
  const res = await fetch(`/api/bridge/${name}/ensure`, { method: 'POST' })
  let body: BridgeEnsureResult
  try {
    body = (await res.json()) as BridgeEnsureResult
  } catch {
    throw new Error(`桥接启动接口无响应（HTTP ${res.status}）。请确认正在 npm run dev。`)
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.message || `无法启动 ${name} 桥接`)
  }
  return body
}
