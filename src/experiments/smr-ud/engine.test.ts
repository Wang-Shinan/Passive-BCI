import { describe, expect, it } from 'vitest'
import {
  RunningNorm,
  UD_DEFAULT_GAIN,
  UD_FEEDBACK_SEC,
  UD_REST_SEC,
  applyDeadzone,
  clampGain,
  decayToward,
  hitUdEdge,
  keyboardZV,
  mixControl,
  nextTarget,
  pushTrail,
  resolveUdTarget,
  stepUdY,
  summarizeUd,
  udBars,
  udIntent,
} from './engine'

describe('UD cursor', () => {
  it('deadzones small vertical drive', () => {
    expect(applyDeadzone(0.04)).toBe(0)
    expect(applyDeadzone(-0.09)).toBe(-0.09)
  })

  it('moves up with positive zV and clamps', () => {
    expect(stepUdY(0.5, 2, 0.04, 1)).toBeCloseTo(0.58)
    expect(stepUdY(0.99, 4, 0.04, 1)).toBe(1)
    expect(stepUdY(0.01, -4, 0.04, 1)).toBe(0)
  })

  it('hits top and bottom with a demo-sized pad', () => {
    expect(hitUdEdge(0.97)).toBe('up')
    expect(hitUdEdge(0.02)).toBe('down')
    expect(hitUdEdge(0.5)).toBeNull()
  })
})

describe('control mix', () => {
  it('lets held keys override the decoder', () => {
    expect(keyboardZV(true, false)).toBeGreaterThan(0)
    expect(keyboardZV(false, true)).toBeLessThan(0)
    expect(keyboardZV(true, true)).toBeNull()
    expect(keyboardZV(false, false)).toBeNull()
    expect(mixControl(0.2, 1.4)).toBe(1.4)
    expect(mixControl(0.2, null)).toBe(0.2)
  })

  it('labels intent from signed vertical drive', () => {
    expect(udIntent(0.5)).toBe('up')
    expect(udIntent(-0.5)).toBe('down')
    expect(udIntent(0.02)).toBe('idle')
  })

  it('decays stale drive toward zero', () => {
    const next = decayToward(1, 0.28, 0.28)
    expect(next).toBeCloseTo(Math.exp(-1), 5)
  })
})

describe('targets', () => {
  it('prefers switching sides', () => {
    expect(nextTarget('up', () => 0.1)).toBe('down')
    expect(nextTarget('down', () => 0.1)).toBe('up')
    expect(nextTarget('up', () => 0.9)).toBe('up')
  })

  it('scores a hit, opposite-edge miss, and timeout', () => {
    expect(resolveUdTarget(0.98, 'up', 1)).toBe('hit')
    expect(resolveUdTarget(0.01, 'up', 1)).toBe('miss')
    expect(resolveUdTarget(0.5, 'down', 8)).toBe('timeout')
    expect(resolveUdTarget(0.5, 'down', 2)).toBeNull()
  })

  it('gives 8s to hit, then 2s rest before the next target', () => {
    expect(UD_REST_SEC).toBe(2)
    expect(UD_FEEDBACK_SEC).toBe(8)
    expect(resolveUdTarget(0.5, 'down', 7.9)).toBeNull()
    expect(resolveUdTarget(0.5, 'down', 8)).toBe('timeout')
  })

  it('keeps default gain well below the old REVE×SMR product', () => {
    expect(UD_DEFAULT_GAIN).toBeLessThan(0.5)
    expect(clampGain(0)).toBe(0.08)
    expect(clampGain(9)).toBe(1)
    expect(stepUdY(0.5, 1, 0.04, UD_DEFAULT_GAIN)).toBeCloseTo(0.5 + UD_DEFAULT_GAIN * 0.04)
  })

  it('summarizes PVC ignoring timeouts in the denominator', () => {
    const score = summarizeUd(['hit', 'hit', 'miss', 'timeout'])
    expect(score.hits).toBe(2)
    expect(score.n).toBe(4)
    expect(score.pvc).toBeCloseTo(2 / 3)
  })
})

describe('REVE bars', () => {
  it('maps both_hand / rest onto the vertical axis', () => {
    const names = ['left_hand', 'right_hand', 'both_hand', 'rest']
    const up = udBars(names, [0.05, 0.05, 0.8, 0.1])
    const down = udBars(names, [0.05, 0.05, 0.1, 0.8])
    expect(up.up).toBeCloseTo(0.8)
    expect(up.zV).toBeCloseTo(0.7 / 0.9)
    expect(up.upShare).toBeCloseTo(0.8 / 0.9)
    expect(down.down).toBeCloseTo(0.8)
    expect(down.zV).toBeCloseTo(-0.7 / 0.9)
  })

  it('still reads up/down when left/right dominate the softmax', () => {
    const names = ['left_hand', 'right_hand', 'both_hand', 'rest']
    const up = udBars(names, [0.45, 0.4, 0.12, 0.03])
    const down = udBars(names, [0.42, 0.43, 0.03, 0.12])
    const tie = udBars(names, [0.4, 0.4, 0.1, 0.1])
    expect(up.left + up.right).toBeCloseTo(0.85)
    expect(up.zV).toBeCloseTo(0.6)
    expect(up.upShare).toBeCloseTo(0.8)
    expect(down.zV).toBeCloseTo(-0.6)
    expect(tie.zV).toBeCloseTo(0)
  })
})

describe('helpers', () => {
  it('z-scores after enough samples', () => {
    const norm = new RunningNorm()
    expect(norm.z(3)).toBe(0)
    for (let i = 0; i < 20; i++) norm.push(i % 2 === 0 ? 0 : 2)
    expect(norm.z(2)).toBeGreaterThan(0)
    expect(norm.z(0)).toBeLessThan(0)
  })

  it('keeps a fixed-length trail', () => {
    let trail: number[] = []
    for (let i = 0; i < 20; i++) trail = pushTrail(trail, i, 5)
    expect(trail).toEqual([15, 16, 17, 18, 19])
  })
})
