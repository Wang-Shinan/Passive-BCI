import { describe, expect, it } from 'vitest'
import { BCIGO_CHANNEL_NAMES } from '../../acquisition/bcigo/client'
import { NEURACLE_59_EEG_CHANNEL_NAMES } from '../../acquisition/neuracle/client'
import {
  BalancedNorm,
  alphaPower,
  classSide,
  copyRecentSamples,
  hitEdge,
  laplacianTrace,
  outcomeForHit,
  pvc,
  proficient,
  resetCursor,
  resolveLaplacianMontage,
  reveCursorAxes,
  smrClassMasses,
  smrFeatures,
  stepCursor,
} from './smrControl'

function sine(freq: number, sampleRate: number, sec: number, amp = 10): Float32Array {
  const n = Math.round(sampleRate * sec)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

describe('montage', () => {
  it('uses small Laplacian on Neuracle 59', () => {
    const montage = resolveLaplacianMontage(NEURACLE_59_EEG_CHANNEL_NAMES)
    expect(montage).not.toBeNull()
    expect(montage!.neighborNamesC3).toEqual(['FC3', 'C1', 'C5', 'CP3'])
    expect(montage!.neighborNamesC4).toEqual(['FC4', 'C2', 'C6', 'CP4'])
  })

  it('falls back to BCIGo neighbors', () => {
    const montage = resolveLaplacianMontage(BCIGO_CHANNEL_NAMES)
    expect(montage).not.toBeNull()
    expect(montage!.neighborNamesC3).toEqual(['FC1', 'FC5', 'CP1', 'CP5'])
    expect(montage!.neighborNamesC4).toEqual(['FC2', 'FC6', 'CP2', 'CP6'])
  })

  it('returns null without C3/C4', () => {
    expect(resolveLaplacianMontage(['Fp1', 'Cz'])).toBeNull()
  })
})

describe('copyRecentSamples', () => {
  it('unwraps the ring', () => {
    const buf = new Float32Array([8, 9, 0, 1, 2, 3, 4, 5, 6, 7])
    const out = copyRecentSamples(buf, 2, 10, 4)
    expect([...out]).toEqual([6, 7, 8, 9])
  })
})

describe('laplacian and features', () => {
  it('subtracts neighbor mean', () => {
    const center = new Float32Array([10, 10])
    const a = new Float32Array([4, 6])
    const b = new Float32Array([6, 8])
    expect([...laplacianTrace(center, [a, b])]).toEqual([5, 3])
  })

  it('maps left-hand ERD to left and rest to down', () => {
    const left = smrFeatures(1, 8)
    const right = smrFeatures(8, 1)
    const up = smrFeatures(1, 1)
    const down = smrFeatures(8, 8)
    expect(left.horiz).toBeLessThan(right.horiz)
    expect(up.vert).toBeGreaterThan(down.vert)
  })
})

describe('alpha power', () => {
  it('is higher for a 12 Hz sine than a 30 Hz sine on short BCIGo windows', () => {
    const mu = alphaPower(sine(12, 250, 0.16), 250)
    const beta = alphaPower(sine(30, 250, 0.16), 250)
    expect(mu).toBeGreaterThan(beta * 3)
  })

  it('keeps the 12 Hz peak on 1000 Hz / 160 ms windows', () => {
    const mu = alphaPower(sine(12, 1000, 0.16), 1000)
    const beta = alphaPower(sine(30, 1000, 0.16), 1000)
    expect(mu).toBeGreaterThan(beta * 3)
  })
})

describe('cursor and scoring', () => {
  it('locks the unused axis in 1D tasks', () => {
    const moved = stepCursor(resetCursor(), 'LR', 2, 2, 0.04, 1)
    expect(moved.y).toBe(0.5)
    expect(moved.x).toBeGreaterThan(0.5)
  })

  it('detects edges and PVC', () => {
    expect(hitEdge({ x: 0, y: 0.5 })).toBe('left')
    expect(hitEdge({ x: 0.5, y: 1 })).toBe('up')
    expect(outcomeForHit('left', 'left', false)).toBe('hit')
    expect(outcomeForHit('left', 'right', false)).toBe('miss')
    expect(outcomeForHit('left', null, true)).toBe('timeout')
    expect(pvc(['hit', 'hit', 'miss', 'timeout'])).toBeCloseTo(2 / 3)
    expect(proficient('LR', 0.7)).toBe(true)
    expect(proficient('2D', 0.39)).toBe(false)
  })

  it('balances class buffers so left/right mean to ~0', () => {
    const norm = new BalancedNorm(30, 0.04)
    for (let i = 0; i < 20; i++) {
      norm.push('neg', -2)
      norm.push('pos', 4)
    }
    const stats = norm.stats()
    expect(stats).not.toBeNull()
    expect(stats!.mean).toBeCloseTo(1, 5)
    expect(norm.z(4)).toBeGreaterThan(0)
    expect(norm.z(-2)).toBeLessThan(0)
    expect(classSide('right', 'horiz')).toBe('pos')
    expect(classSide('down', 'vert')).toBe('neg')
  })

  it('flips horizontal polarity when right-class alpha laterality is inverted', () => {
    const norm = new BalancedNorm(30, 0.04)
    for (let i = 0; i < 80; i++) {
      norm.push('pos', -2)
      norm.push('neg', 4)
    }
    expect(norm.flipped()).toBe(true)
    expect(norm.polarity()).toBe(-1)
    expect(norm.z(-2)).toBeGreaterThan(0)
    expect(norm.z(4)).toBeLessThan(0)
  })
})

describe('reveCursorAxes', () => {
  it('exposes class masses for the UD demo bars', () => {
    const names = ['left_hand', 'right_hand', 'both_hand', 'rest']
    const mass = smrClassMasses(names, [0.05, 0.05, 0.8, 0.1])
    expect(mass.up).toBeCloseTo(0.8)
    expect(mass.down).toBeCloseTo(0.1)
  })

  it('turns 4-class probabilities into left/right/up/down cursor axes', () => {
    const names = ['left_hand', 'right_hand', 'both_hand', 'rest']
    expect(reveCursorAxes(names, [0.8, 0.1, 0.05, 0.05]).zH).toBeCloseTo(-0.7)
    expect(reveCursorAxes(names, [0.1, 0.8, 0.05, 0.05]).zH).toBeCloseTo(0.7)
    expect(reveCursorAxes(names, [0.05, 0.05, 0.8, 0.1]).zV).toBeCloseTo(0.7)
    expect(reveCursorAxes(names, [0.05, 0.05, 0.1, 0.8]).zV).toBeCloseTo(-0.7)
  })
})
