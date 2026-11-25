export const DEFAULT_OMNI_GUI_PORT = 8766
export const OMNI_GUI_PORT_CANDIDATES = [DEFAULT_OMNI_GUI_PORT, 8769] as const
export const OMNI_GUI_PROXY_PATH = '/api/omni-gui'

const STORAGE_KEY = 'passive-bci.omni-gui-port'

export function parseOmniGuiPort(value: string): number | null {
  const port = Number(value)
  return /^\d{1,5}$/.test(value) && port >= 1 && port <= 65535 ? port : null
}

export function omniGuiOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function omniGuiProxyPath(port: number): string {
  return port === DEFAULT_OMNI_GUI_PORT ? OMNI_GUI_PROXY_PATH : `${OMNI_GUI_PROXY_PATH}/${port}`
}

export function loadOmniGuiPort(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? '' }
  catch { return '' }
}

export function saveOmniGuiPort(value: string): void {
  try { localStorage.setItem(STORAGE_KEY, value) }
  catch { /* The current value still works. */ }
}

export async function resolveOmniGuiPort(value: string): Promise<number> {
  const selection = value.trim()
  const port = selection ? parseOmniGuiPort(selection) : null
  if (selection && port === null) throw new Error('GUI HTTP 端口须为 1–65535 的整数。')
  const url = `${OMNI_GUI_PROXY_PATH}/discover${port === null ? '' : `?port=${port}`}`
  const response = await fetch(url, { cache: 'no-store' })
  const result = await response.json().catch(() => null) as { port?: number } | null
  if (response.ok && typeof result?.port === 'number' && parseOmniGuiPort(String(result.port)) !== null) return result.port
  throw new Error(port === null
    ? `在本机 ${OMNI_GUI_PORT_CANDIDATES.join('、')} 没有找到 OmniBCI GUI。请确认 GUI 正在运行，或手动输入转发端口。`
    : `无法连接 ${omniGuiOrigin(port)}/v1/status。请确认 OmniBCI GUI 正在运行且该转发端口可达。`)
}
