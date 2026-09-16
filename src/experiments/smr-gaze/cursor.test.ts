import { describe, expect, it } from 'vitest'
import { moveCursor, moveProbabilityCursor, reachedEdge } from './cursor'

describe('continuous gaze cursor', () => {
  it('only scores the cued edge anywhere along its length', () => {
    expect(reachedEdge({ x: .04, y: .8 }, 'left')).toBe(true)
    expect(reachedEdge({ x: .04, y: .8 }, 'right')).toBe(false)
    expect(reachedEdge({ x: .5, y: .5 }, 'up')).toBe(false)
    expect(reachedEdge({ x: .8, y: .96 }, 'down')).toBe(true)
    expect(reachedEdge({ x: .96, y: .3 }, 'right')).toBe(true)
    expect(reachedEdge({ x: .3, y: .04 }, 'up')).toBe(true)
  })
  it('balances REVE probabilities and freezes malformed output', () => {
    const center = { x: 0.5, y: 0.5 }
    expect(moveProbabilityCursor(center, [.25, .25, .25, .25], .1)).toEqual(center)
    const rightUp = moveProbabilityCursor(center, [0, .6, .4, 0], .1)
    expect(rightUp.x).toBeCloseTo(.5324)
    expect(rightUp.y).toBeCloseTo(.4784)
    expect(moveProbabilityCursor(center, [NaN, 0, 0, 1], .1)).toEqual(center)
    expect(moveProbabilityCursor(center, [0, 0, 0, 0], .1)).toEqual(center)
    expect(moveProbabilityCursor(center, [0, 1, 0, 0], 20).x).toBeCloseTo(.554)
  })
  it('integrates direction over elapsed time and stops without a prediction', () => {
    let position = { x: 0.5, y: 0.5 }
    for (let i = 0; i < 25; i++) position = moveCursor(position, 'right', 0.04)
    expect(position.x).toBeCloseTo(0.68)
    expect(position.y).toBe(0.5)
    expect(moveCursor(position, null, 1)).toEqual(position)
    expect(moveCursor(position, 'left', NaN)).toEqual(position)
  })
  it('moves up in screen coordinates, stays within bounds and caps delayed frames', () => {
    expect(moveCursor({ x: 0.5, y: 0.5 }, 'up', 0.1).y).toBeCloseTo(0.482)
    expect(moveCursor({ x: 0.96, y: 0.04 }, 'right', 0.1).x).toBe(0.96)
    expect(moveCursor({ x: 0.04, y: 0.04 }, 'up', 0.1).y).toBe(0.04)
    expect(moveCursor({ x: 0.5, y: 0.5 }, 'down', 20).y).toBeCloseTo(0.518)
  })
})
