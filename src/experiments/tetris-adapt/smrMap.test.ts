import { describe, expect, it } from 'vitest'
import { reveCursorAxes } from '../smr-adapt/smrControl'
import {
  axesFromReve,
  overlapActionFromAxes,
  overlapActionFromClassName,
  smrDirFromClassName,
} from './smrMap'

const NAMES = ['left_hand', 'right_hand', 'both_hand', 'rest'] as const

describe('SMR action mapping', () => {
  it('maps REVE class names onto tetris-adapt directions', () => {
    expect(smrDirFromClassName('left_hand')).toBe('left')
    expect(smrDirFromClassName('right_hand')).toBe('right')
    expect(smrDirFromClassName('both_hand')).toBe('up')
    expect(smrDirFromClassName('rest')).toBe('down')
    expect(overlapActionFromClassName('both_hand')).toBe('rotate')
    expect(overlapActionFromClassName('rest')).toBe('down')
    expect(overlapActionFromClassName('feet')).toBeNull()
  })

  it('uses the same 4-class REVE axes as smr-adapt', () => {
    const left = reveCursorAxes(NAMES, [1, 0, 0, 0])
    const right = reveCursorAxes(NAMES, [0, 1, 0, 0])
    const up = reveCursorAxes(NAMES, [0, 0, 1, 0])
    const down = reveCursorAxes(NAMES, [0, 0, 0, 1])
    expect(left.zH).toBeLessThan(0)
    expect(right.zH).toBeGreaterThan(0)
    expect(up.zV).toBeGreaterThan(0)
    expect(down.zV).toBeLessThan(0)
    const scaled = axesFromReve(NAMES, [0, 1, 0, 0])
    expect(scaled?.zH).toBeGreaterThan(right.zH)
  })

  it('thresholds axes into overlap moves', () => {
    expect(overlapActionFromAxes(-1.2, 0.1)).toBe('left')
    expect(overlapActionFromAxes(1.2, 0.1)).toBe('right')
    expect(overlapActionFromAxes(0.1, 1.2)).toBe('rotate')
    expect(overlapActionFromAxes(0.1, -1.2)).toBe('down')
    expect(overlapActionFromAxes(0.1, 0.1)).toBeNull()
  })
})
