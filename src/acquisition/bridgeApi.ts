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

export interface NeuracleProbeResult {
  ok: boolean
  listening: boolean
  collect: boolean
  port: number
  message?: string
}

export interface OmniProbeResult {
  ok: boolean
  listening: boolean
  port: number
  message?: string
}

export async function probeOmniApi(): Promise<OmniProbeResult> {
  const res = await fetch('/api/bridge/omni/probe')
  try {
    return (await res.json()) as OmniProbeResult
  } catch {
    return {
      ok: false,
      listening: false,
      port: 8765,
      message: '无法探测 OmniBCI V19 本机 API。请确认正在 npm run dev。',
    }
  }
}

export async function probeNeuracleForward(): Promise<NeuracleProbeResult> {
  const res = await fetch('/api/bridge/neuracle/probe')
  try {
    return (await res.json()) as NeuracleProbeResult
  } catch {
    return {
      ok: false,
      listening: false,
      collect: false,
      port: 0,
      message: '无法探测 Collect 转发端口。',
    }
  }
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
