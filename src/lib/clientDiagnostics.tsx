import { Component, type ErrorInfo, type ReactNode } from 'react'

let errorCount = 0
export function reportClientError(kind: string, error: unknown, extra = '') {
  if (++errorCount > 20) return
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : ''
  const data = { kind, message: message.slice(0, 2000), stack: stack?.slice(0, 5000), extra: extra.slice(0, 3000), path: location.pathname }
  try { localStorage.setItem('passive-bci.last-client-error', JSON.stringify({ at: new Date().toISOString(), ...data })) } catch { /* storage may be unavailable */ }
  void fetch('/api/client-diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true }).catch(() => {})
}

export function installClientDiagnostics() {
  const onError = (event: ErrorEvent) => reportClientError('window-error', event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent) => reportClientError('unhandled-rejection', event.reason)
  let expected = performance.now() + 10000
  let pending = false
  const timer = setInterval(() => {
    const now = performance.now(), lagMs = Math.max(0, now - expected); expected = now + 10000
    if (pending) return
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    pending = true
    void fetch('/api/client-diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'heartbeat', path: location.pathname, visibility: document.visibilityState, lagMs,
        heapUsed: memory?.usedJSHeapSize, heapLimit: memory?.jsHeapSizeLimit }), signal: AbortSignal.timeout(5000),
    }).catch(() => {}).finally(() => { pending = false })
  }, 10000)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => { clearInterval(timer); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { reportClientError('react-error', error, info.componentStack ?? '') }
  render() {
    if (!this.state.failed) return this.props.children
    return <main role="alert" style={{ padding: 32 }}>
      <h1>页面发生异常</h1>
      <p>错误已尝试记录到本地。已写入磁盘的采集文件仍保留；刷新会重置当前游戏。</p>
      <button onClick={() => location.reload()}>重新加载页面</button>
    </main>
  }
}
