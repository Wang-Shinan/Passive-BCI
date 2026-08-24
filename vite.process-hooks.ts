/**
 * Vite config reloads re-evaluate plugins in the same Node process.
 * Keep child-process handles and a single `process.exit` listener across those reloads.
 */

const HOOK_KEY = Symbol.for('passive-bci.dev-process-hooks')
const STORE_PREFIX = 'passive-bci.dev-store:'

type HookState = {
  exitInstalled: boolean
  handlers: Map<string, () => void>
}

function hookState(): HookState {
  const g = globalThis as typeof globalThis & { [HOOK_KEY]?: HookState }
  if (!g[HOOK_KEY]) {
    g[HOOK_KEY] = { exitInstalled: false, handlers: new Map() }
  }
  return g[HOOK_KEY]
}

/** Register named cleanup. Re-registering replaces the previous function. */
export function onDevProcessExit(id: string, fn: () => void): void {
  const state = hookState()
  state.handlers.set(id, fn)
  if (state.exitInstalled) return
  state.exitInstalled = true
  process.once('exit', () => {
    for (const handler of state.handlers.values()) {
      try {
        handler()
      } catch {
        /* already tearing down */
      }
    }
  })
}

export function persistentDevStore<T>(id: string, create: () => T): T {
  const key = Symbol.for(`${STORE_PREFIX}${id}`)
  const g = globalThis as typeof globalThis & Record<symbol, T>
  if (g[key] == null) g[key] = create()
  return g[key]
}
