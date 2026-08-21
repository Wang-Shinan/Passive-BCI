import { describe, expect, it } from 'vitest'
import {
  formatLagMs,
  lagWarnLevel,
  liveClockLagMs,
  liveJitterMs,
  liveLagSec,
  noteLiveSamples,
  resetCatchup,
  setCatchupClock,
  addPendingSamples,
  isCatchingUp,
} from './liveCatchup'

describe('live clock lag', () => {
  it('is zero before any samples', () => {
    resetCatchup()
    setCatchupClock(250)
    expect(liveClockLagMs(1000)).toBe(0)
    expect(liveLagSec()).toBe(0)
  })

  it('stays at zero while the next batch is not yet overdue', () => {
    resetCatchup()
    setCatchupClock(250)
    noteLiveSamples(25, 1000)
    expect(liveClockLagMs(1000)).toBe(0)
    expect(liveClockLagMs(1080)).toBe(0)
    noteLiveSamples(25, 1100)
    expect(liveClockLagMs(1100)).toBe(0)
    noteLiveSamples(25, 1200)
    expect(liveClockLagMs(1200)).toBe(0)
  })

  it('grows only by the current overdue gap if the consumer stalls', () => {
    resetCatchup()
    setCatchupClock(250)
    noteLiveSamples(25, 1000)
    // 25 samples @ 250 Hz = 100 ms expected; 300 ms later → 200 ms overdue
    expect(liveClockLagMs(1300)).toBeCloseTo(200, 6)
  })

  it('does not accumulate small persistent rate error', () => {
    resetCatchup()
    setCatchupClock(250)
    let t = 1000
    for (let i = 0; i < 50; i++) {
      noteLiveSamples(25, t)
      t += 102
    }
    // Last interval was 2 ms late, but session-long 50×2 ms must not appear.
    expect(liveClockLagMs(t - 102)).toBeCloseTo(2, 6)
    expect(liveClockLagMs(t - 102)).toBeLessThan(10)
  })

  it('drops after the next on-time packet', () => {
    resetCatchup()
    setCatchupClock(250)
    noteLiveSamples(25, 1000)
    noteLiveSamples(25, 1400)
    expect(liveClockLagMs(1400)).toBeCloseTo(300, 6)
    noteLiveSamples(25, 1500)
    expect(liveClockLagMs(1500)).toBe(0)
  })

  it('tracks extra inter-batch delay as jitter', () => {
    resetCatchup()
    setCatchupClock(250)
    noteLiveSamples(25, 1000)
    noteLiveSamples(25, 1250)
    expect(liveJitterMs()).toBeCloseTo(150, 6)
  })
})

describe('lag display helpers', () => {
  it('formats ms and seconds', () => {
    expect(formatLagMs(42.2)).toBe('42 ms')
    expect(formatLagMs(1500)).toBe('1.50 s')
  })

  it('maps warn levels', () => {
    expect(lagWarnLevel(20, 0)).toBe(0)
    expect(lagWarnLevel(90, 0)).toBe(1)
    expect(lagWarnLevel(40, 0.25)).toBe(2)
  })
})

describe('catch-up hysteresis', () => {
  it('does not flicker around a Collect-sized packet gap', () => {
    resetCatchup()
    setCatchupClock(1000)
    expect(isCatchingUp()).toBe(false)
    addPendingSamples(200)
    expect(isCatchingUp()).toBe(false)
    addPendingSamples(200)
    expect(isCatchingUp()).toBe(true)
    addPendingSamples(-250)
    expect(isCatchingUp()).toBe(true)
    addPendingSamples(-100)
    expect(isCatchingUp()).toBe(false)
  })

  it('ignores inter-batch clock lag', () => {
    resetCatchup()
    setCatchupClock(1000)
    noteLiveSamples(5, 1000)
    noteLiveSamples(5, 1400)
    expect(liveClockLagMs(1400)).toBeGreaterThan(200)
    expect(isCatchingUp()).toBe(false)
  })
})
