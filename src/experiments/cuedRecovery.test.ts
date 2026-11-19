import { describe, expect, it, vi } from 'vitest'
import { CuedRecovery, type CuedRecoveryHooks } from './cuedRecovery'
import * as guiSession from '../acquisition/omni/guiSession'
import type { GuiContinuityEvent } from '../acquisition/omni/guiSession'

function harness(over: Partial<CuedRecoveryHooks> = {}) {
  const calls = { invalidated: 0, interrupted: 0, resumed: [] as number[], completed: 0, stopped: [] as string[], waiting: [] as boolean[] }
  const state = { phase: 'collect' as string, index: 0, planLength: 4, ready: true, active: true, ownsReopen: true }
  const hooks: CuedRecoveryHooks = {
    hasActiveRun: () => state.active,
    inInterruptiblePhase: () => state.phase !== 'recovery',
    nextTrialIndex: () => state.index + 1,
    planLength: () => state.planLength,
    readyToResume: () => state.ready,
    onInterrupt: () => { calls.interrupted += 1 },
    invalidateCurrent: () => { calls.invalidated += 1 },
    resumeNext: (next) => { calls.resumed.push(next); state.index = next; state.phase = 'prepare' },
    completeRun: () => { calls.completed += 1 },
    ownsReopen: () => state.ownsReopen,
    onStopped: (reason) => { calls.stopped.push(reason) },
    onWaitingChange: (waiting) => { calls.waiting.push(waiting) },
    ...over,
  }
  const recovery = new CuedRecovery(hooks)
  recovery.arm()
  return { recovery, calls, state }
}

const interrupt = (reason = 'conflict'): GuiContinuityEvent => ({
  type: 'interrupt', reason, detail: reason,
  context: { sessionId: 's', generation: 8, segmentId: 0, channelNames: [], sampleRate: 250 },
})
const ready: GuiContinuityEvent = {
  type: 'ready',
  context: { sessionId: 's', generation: 8, segmentId: 1, channelNames: [], sampleRate: 250 },
}

describe('CuedRecovery', () => {
  it('mid-collect: invalidates once, waits, then resumes the NEXT trial at prepare', async () => {
    const { recovery, calls, state } = harness()
    await recovery.handleEvent(interrupt())
    expect(calls.invalidated).toBe(1)
    expect(recovery.waiting).toBe(true)
    await recovery.handleEvent(ready)
    expect(calls.resumed).toEqual([1])
    expect(state.phase).toBe('prepare')
    expect(recovery.waiting).toBe(false)
  })

  it('a gap during recovery (rest) does not invalidate or double count', async () => {
    const { recovery, calls, state } = harness()
    state.phase = 'recovery'
    state.index = 0
    await recovery.handleEvent(interrupt())
    expect(calls.interrupted).toBe(1)
    expect(calls.invalidated).toBe(0)
    expect(recovery.waiting).toBe(true)
    await recovery.handleEvent(ready)
    expect(calls.resumed).toEqual([1])
  })

  it('coalesces repeated resets into one remembered next index', async () => {
    const { recovery, calls, state } = harness()
    state.index = 2
    await recovery.handleEvent(interrupt())
    await recovery.handleEvent(interrupt('transport'))
    await recovery.handleEvent(interrupt('stalled'))
    expect(calls.invalidated).toBe(1)
    await recovery.handleEvent(ready)
    expect(calls.resumed).toEqual([3])
  })

  it('last interrupted trial completes the run with no phantom trial', async () => {
    const { recovery, calls, state } = harness()
    state.index = 3
    await recovery.handleEvent(interrupt())
    await recovery.handleEvent(ready)
    expect(calls.completed).toBe(1)
    expect(calls.resumed).toEqual([])
  })

  it('does not advance until readiness (new recorder + fresh samples) reports true', async () => {
    const { recovery, calls, state } = harness()
    await recovery.handleEvent(interrupt())
    state.ready = false
    await recovery.handleEvent(ready)
    expect(calls.resumed).toEqual([])
    expect(recovery.waiting).toBe(true)
    recovery.maybeResume()
    expect(calls.resumed).toEqual([])
    state.ready = true
    recovery.maybeResume()
    expect(calls.resumed).toEqual([1])
  })

  it('cancel while waiting suppresses owned reopen and cannot resume later', async () => {
    const suppress = vi.spyOn(guiSession, 'suppressGuiSegmentReopen')
    try {
      const { recovery, calls } = harness()
      await recovery.handleEvent(interrupt())
      expect(recovery.waiting).toBe(true)
      recovery.cancel()
      expect(suppress).toHaveBeenCalledTimes(1)
      await recovery.handleEvent(ready)
      recovery.maybeResume()
      expect(calls.resumed).toEqual([])
      expect(calls.completed).toBe(0)
    } finally {
      suppress.mockRestore()
    }
  })

  it('cancel does not suppress a reopen the run does not own', async () => {
    const suppress = vi.spyOn(guiSession, 'suppressGuiSegmentReopen')
    try {
      const { recovery, state } = harness()
      state.ownsReopen = false
      await recovery.handleEvent(interrupt())
      recovery.cancel()
      expect(suppress).not.toHaveBeenCalled()
    } finally {
      suppress.mockRestore()
    }
  })

  it('owned cancel returns the suppression promise: pending until release, never resumes meanwhile', async () => {
    let releaseSuppress: (() => void) | null = null
    const deferred = new Promise<void>((resolve) => { releaseSuppress = () => resolve() })
    const suppress = vi.spyOn(guiSession, 'suppressGuiSegmentReopen')
      .mockImplementation(() => deferred)
    try {
      const { recovery, calls } = harness()
      await recovery.handleEvent(interrupt())
      expect(recovery.waiting).toBe(true)
      const cancelling = recovery.cancel()
      let settled = false
      void Promise.resolve(cancelling).then(() => { settled = true })
      await new Promise((r) => setTimeout(r, 0))
      expect(settled).toBe(false)
      recovery.cancel()
      recovery.detach()
      await new Promise((r) => setTimeout(r, 0))
      expect(settled).toBe(false)
      await recovery.handleEvent(ready)
      recovery.maybeResume()
      expect(calls.resumed).toEqual([])
      releaseSuppress!()
      await cancelling
      expect(settled).toBe(true)
    } finally {
      suppress.mockRestore()
    }
  })

  it('arm resets a pending cancellation so the next run suppresses anew', async () => {
    let releaseSuppress: (() => void) | null = null
    const first = new Promise<void>((resolve) => { releaseSuppress = () => resolve() })
    const suppress = vi.spyOn(guiSession, 'suppressGuiSegmentReopen')
      .mockImplementation(() => first)
    try {
      const { recovery, calls } = harness()
      await recovery.handleEvent(interrupt())
      const cancelling = recovery.cancel()
      recovery.arm()
      releaseSuppress!()
      await cancelling
      suppress.mockImplementation(() => Promise.resolve())
      await recovery.handleEvent(interrupt())
      const second = recovery.cancel()
      await expect(Promise.resolve(second)).resolves.toBeUndefined()
      expect(suppress).toHaveBeenCalledTimes(2)
      expect(calls.resumed).toEqual([])
    } finally {
      suppress.mockRestore()
    }
  })

  it('non-owned cancel resolves without suppressing the acquisition-owned reopen', async () => {
    const suppress = vi.spyOn(guiSession, 'suppressGuiSegmentReopen')
    try {
      const { recovery, state } = harness()
      state.ownsReopen = false
      await recovery.handleEvent(interrupt())
      const cancelling = recovery.cancel()
      await expect(Promise.resolve(cancelling)).resolves.toBeUndefined()
      expect(suppress).not.toHaveBeenCalled()
      await recovery.handleEvent(ready)
    } finally {
      suppress.mockRestore()
    }
  })

  it('a fresh arm() after cancel re-enables the next run', async () => {
    const { recovery, calls } = harness()
    await recovery.handleEvent(interrupt())
    recovery.cancel()
    recovery.arm()
    await recovery.handleEvent(interrupt())
    expect(recovery.waiting).toBe(true)
    await recovery.handleEvent(ready)
    expect(calls.resumed).toEqual([1])
    expect(calls.invalidated).toBe(2)
  })

  it('ignores interruptions with no active run and non-GUI runs', async () => {
    const { recovery, calls, state } = harness()
    state.active = false
    await recovery.handleEvent(interrupt())
    expect(recovery.waiting).toBe(false)
    expect(calls.invalidated).toBe(0)
    await recovery.handleEvent(ready)
    expect(calls.resumed).toEqual([])
  })

  it('forwards stopped events to the page for a visible stop', async () => {
    const { recovery, calls } = harness()
    await recovery.handleEvent(interrupt())
    await recovery.handleEvent({ type: 'stopped', reason: 'save failed' })
    expect(calls.stopped).toEqual(['save failed'])
  })

  it('async invalidation is awaited before the interrupt returns', async () => {
    let release: (() => void) | null = null
    const calls = { n: 0 }
    const { recovery } = harness({
      invalidateCurrent: () => new Promise<void>((resolve) => {
        release = () => { calls.n += 1; resolve() }
      }),
    })
    let settled = false
    void Promise.resolve(recovery.handleEvent(interrupt())).then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    release!()
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(true)
    expect(calls.n).toBe(1)
  })
})
