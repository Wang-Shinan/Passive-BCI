import type { NBackSave } from './contracts'
export type { NBackSave } from './contracts'
const PREFIX = 'passive-bci.nback.pending.'
const queues = new Map<string, Promise<void>>()

/** Keep a browser backup until the server confirms the snapshot reached disk. */
export function saveNBack(snapshot: NBackSave, notify: (message: string) => void): void {
  const payload = JSON.stringify(snapshot)
  const key = PREFIX + snapshot.id
  let backedUp = false
  try { localStorage.setItem(key, payload); backedUp = true } catch { /* Report failure below. */ }
  const work = (queues.get(snapshot.id) ?? Promise.resolve()).then(async () => {
    try {
      const response = await fetch('/api/record/nback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
        signal: AbortSignal.timeout(8000),
      })
      const body = await response.json() as { ok?: boolean; rel?: string; message?: string }
      if (!response.ok || !body.ok) throw new Error(body.message || '保存接口不可用')
      try {
        if (localStorage.getItem(key) === payload) localStorage.removeItem(key)
      } catch { /* Disk save succeeded. */ }
      notify(`已自动保存：${body.rel}`)
    } catch (error) {
      notify(`${backedUp ? '已暂存浏览器，点击重试保存到会话库' : '保存失败，请立即导出 JSON'}：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  queues.set(snapshot.id, work)
  void work.finally(() => { if (queues.get(snapshot.id) === work) queues.delete(snapshot.id) })
}

export function retryNBackSaves(notify: (message: string) => void): void {
  const pending: NBackSave[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(PREFIX)) {
        try { pending.push(JSON.parse(localStorage.getItem(key)!) as NBackSave) } catch { /* Ignore malformed backup. */ }
      }
    }
  } catch { return }
  for (const snapshot of pending) {
    if (queues.has(snapshot.id)) continue
    saveNBack({ ...snapshot, status: snapshot.status === 'running' ? 'interrupted' : snapshot.status }, notify)
  }
}
