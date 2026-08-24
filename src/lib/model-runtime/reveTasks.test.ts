import { describe, expect, it } from 'vitest'
import { classBarColor, defaultReveStrategy, isReveTaskId, labelHotkey, liveStepSecForReveTask, reveLiveHopMatches, rewardForClass, TETRIS_LIVE_STEP_SEC } from './reveTasks'

describe('reve task catalog', () => {
  it('accepts known task ids only', () => {
    expect(isReveTaskId('smr_control')).toBe(true)
    expect(isReveTaskId('passive_rating')).toBe(true)
    expect(isReveTaskId('rating')).toBe(false)
  })

  it('keeps smr_control frozen and other heads updatable', () => {
    expect(defaultReveStrategy('smr_control')).toBe('none')
    expect(defaultReveStrategy('passive_rating')).toBe('supervised-head')
    expect(defaultReveStrategy('tetris_action')).toBe('supervised-head')
  })

  it('uses 0.1s live hop for Tetris decode and 0.5s for SMR-adapt', () => {
    expect(liveStepSecForReveTask('tetris_action')).toBe(TETRIS_LIVE_STEP_SEC)
    expect(liveStepSecForReveTask('smr_control')).toBe(0.5)
    expect(liveStepSecForReveTask('passive_rating')).toBe(0.5)
    expect(reveLiveHopMatches(0.1, TETRIS_LIVE_STEP_SEC)).toBe(true)
    expect(reveLiveHopMatches(0.5, TETRIS_LIVE_STEP_SEC)).toBe(false)
    expect(reveLiveHopMatches(undefined, TETRIS_LIVE_STEP_SEC)).toBe(false)
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

  it('keeps the 3-class palette colors distinct', () => {
    expect(classBarColor(0, 3)).not.toBe(classBarColor(1, 3))
    expect(classBarColor(1, 3)).not.toBe(classBarColor(2, 3))
    expect(classBarColor(0, 3)).not.toBe(classBarColor(2, 3))
  })
})
