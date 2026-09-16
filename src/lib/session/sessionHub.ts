import type { SessionBindMeta, SessionContextRecord, SessionEventRecord } from './contracts'

export type SessionHubInfo = {
  active: boolean
  id: string | null
  rel: string | null
}

const CONTEXT_FLUSH_MS = 400
const CONTEXT_FLUSH_N = 8

export class SessionHub {
  private id: string | null = null
  private rel: string | null = null
  private eventQ: string[] = []
  private contextQ: string[] = []
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private contextTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(info: SessionHubInfo) => void>()
  private flushChain: Promise<void> = Promise.resolve()

  get info(): SessionHubInfo {
    return { active: this.id !== null, id: this.id, rel: this.rel }
  }

  get active(): boolean {
    return this.id !== null
  }

  subscribe(fn: (info: SessionHubInfo) => void): () => void {
    this.listeners.add(fn)
    fn(this.info)
    return () => {
      this.listeners.delete(fn)
    }
  }

  attach(info: { id: string; rel: string }): void {
    if (this.id && this.id !== info.id) {
      void this.flush()
    }
    this.id = info.id
    this.rel = info.rel
    this.notify()
  }

  detach(): void {
    this.clearTimer()
    this.id = null
    this.rel = null
    this.eventQ = []
    this.contextQ = []
    this.notify()
  }

  /** Drop queued lines without posting (session folder is being deleted). */
  discardAndDetach(): void {
    this.eventQ = []
    this.contextQ = []
    this.detach()
  }

  logEvent(record: SessionEventRecord): void {
    if (!this.id) return
    this.eventQ.push(JSON.stringify(record))
    if (this.eventTimer !== null) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      void this.flushEvents()
    }, CONTEXT_FLUSH_MS)
  }

  logContext(record: SessionContextRecord): void {
    if (!this.id) return
    this.contextQ.push(JSON.stringify(record))
    if (this.contextQ.length >= CONTEXT_FLUSH_N) {
      void this.flushContext()
      return
    }
    if (this.contextTimer !== null) return
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null
      void this.flushContext()
    }, CONTEXT_FLUSH_MS)
  }

  bindMeta(meta: SessionBindMeta): void {
    const id = this.id
    if (!id) return
    void fetch(`/api/record/${id}/meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    }).catch(() => undefined)
  }

  async refreshFromServer(): Promise<SessionHubInfo> {
    try {
      const res = await fetch('/api/record/active')
      if (!res.ok) return this.info
      const body = (await res.json()) as {
        ok?: boolean
        id?: string | null
        rel?: string | null
      }
      if (body.ok && body.id && body.rel) {
        if (this.id !== body.id) this.attach({ id: body.id, rel: body.rel })
      }
    } catch {
      /* ignore */
    }
    return this.info
  }

  async flush(): Promise<void> {
    this.clearTimer()
    await Promise.all([this.flushEvents(), this.flushContext()])
    await this.flushChain.catch(() => undefined)
  }

  private notify(): void {
    const info = this.info
    for (const fn of this.listeners) fn(info)
  }

  private clearTimer(): void {
    if (this.eventTimer !== null) {
      clearTimeout(this.eventTimer)
      this.eventTimer = null
    }
    if (this.contextTimer === null) return
    clearTimeout(this.contextTimer)
    this.contextTimer = null
  }

  private async flushEvents(): Promise<void> {
    await this.postQueue('events', this.eventQ)
  }

  private async flushContext(): Promise<void> {
    if (this.contextTimer !== null) clearTimeout(this.contextTimer)
    this.contextTimer = null
    await this.postQueue('context', this.contextQ)
  }

  private async postQueue(stream: 'events' | 'context', queue: string[]): Promise<void> {
    if (!this.id || queue.length === 0) return
    const id = this.id
    const lines = queue.splice(0, queue.length)
    const body = `${lines.join('\n')}\n`
    this.flushChain = this.flushChain.then(async () => {
      if (!this.id) return
      const res = await fetch(`/api/record/${id}/${stream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
      })
      if (!res.ok) throw new Error(`record ${stream} failed (${res.status})`)
    }).catch((err) => {
      console.error(`[session] ${stream} flush failed`, err)
    })
    await this.flushChain
  }
}

export const sessionHub = new SessionHub()

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void sessionHub.flush()
  })
}
