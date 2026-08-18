import { describe, expect, it } from 'vitest'
import { onDevProcessExit, persistentDevStore } from './vite.process-hooks.ts'

describe('persistentDevStore', () => {
  it('returns the same object across calls', () => {
    const a = persistentDevStore('test-store', () => ({ n: 1 }))
    a.n = 7
    const b = persistentDevStore('test-store', () => ({ n: 0 }))
    expect(b).toBe(a)
    expect(b.n).toBe(7)
  })
})

describe('onDevProcessExit', () => {
  it('does not add a new process exit listener on re-register', () => {
    onDevProcessExit('test-hook', () => undefined)
    const afterFirst = process.listeners('exit').length
    onDevProcessExit('test-hook', () => undefined)
    onDevProcessExit('test-hook', () => undefined)
    expect(process.listeners('exit').length).toBe(afterFirst)
  })
})
