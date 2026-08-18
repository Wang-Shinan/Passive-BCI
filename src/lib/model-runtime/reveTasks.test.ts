import { describe, expect, it } from 'vitest'
import { classBarColor, isReveTaskId, labelHotkey, rewardForClass } from './reveTasks'

describe('reve task catalog', () => {
  it('accepts known task ids only', () => {
    expect(isReveTaskId('smr_control')).toBe(true)
    expect(isReveTaskId('passive_rating')).toBe(true)
    expect(isReveTaskId('rating')).toBe(false)
  })

  it('only attaches ordinal rewards to the rating head', () => {
    expect(rewardForClass('ordinal_rating_3', 0)).toBe(-1)
    expect(rewardForClass('ordinal_rating_3', 2)).toBe(1)
    expect(rewardForClass('smr_control_4', 0)).toBeUndefined()
    expect(rewardForClass('tetris_action_7', 3)).toBeUndefined()
  })

  it('maps number keys 1..9 onto class indices', () => {
    expect(labelHotkey(0)).toBe('1')
    expect(labelHotkey(3)).toBe('4')
    expect(labelHotkey(9)).toBeNull()
  })

  it('keeps the 3-class rating colors distinct', () => {
    expect(classBarColor(0, 3)).toBe('var(--danger)')
    expect(classBarColor(2, 3)).toBe('var(--accent-2)')
    expect(classBarColor(0, 4)).not.toBe(classBarColor(0, 3))
  })
})
