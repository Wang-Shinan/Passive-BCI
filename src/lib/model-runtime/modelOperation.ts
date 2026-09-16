/** One operation owner: late requests cannot undo an explicit stop. No browser dependencies. */
export class ModelOperation {
  private current: AbortController | null = null
  private listeners = new Set<() => void>()
  get busy(): boolean { return this.current !== null }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private notify(): void { for (const fn of this.listeners) fn() }
  cancel(): void {
    const previous = this.current
    this.current = null
    previous?.abort()
    this.notify()
  }
  async run<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.busy) throw new Error('模型操作正在进行，请先完成或停止当前操作')
    signal?.throwIfAborted()
    const owner = new AbortController()
    this.current = owner
    const cancel = () => { if (this.current === owner) this.cancel(); else owner.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    this.notify()
    try {
      const result = await action(owner.signal)
      owner.signal.throwIfAborted()
      if (this.current !== owner) throw new DOMException('模型操作已取消', 'AbortError')
      return result
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (this.current === owner) { this.current = null; this.notify() }
    }
  }
}
export const modelOperation = new ModelOperation()
