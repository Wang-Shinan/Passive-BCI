import { describe, expect, it } from 'vitest'
import { makeLeftRightPlan } from './classifier'
import { tetrisDirection } from './GazeTetris'

describe('left/right collection', () => {
  for (const count of [10,20] as const) it(`collects ${count} of each direction with held-out coverage`, () => {
    const plan=makeLeftRightPlan(9,count)
    expect(plan).toHaveLength(count*2)
    for (const direction of ['left','right']) {
      expect(plan.filter(t=>t.target===direction)).toHaveLength(count)
      expect(plan.filter(t=>t.target===direction && t.run===3)).toHaveLength(count*.2)
    }
    expect(new Set(plan.map(t=>t.index)).size).toBe(count*2)
    expect(makeLeftRightPlan(9,count)).toEqual(plan)
  })
  it('does not issue game actions for uncertain output',()=>{
    expect(tetrisDirection([.25,.25,.25,.25])).toBeNull()
    expect(tetrisDirection([.3,.7,0,0])).toBe('right')
    expect(tetrisDirection([NaN,1,0,0])).toBeNull()
    expect(tetrisDirection([0,0,.8,.2])).toBe('up')
  })
})
