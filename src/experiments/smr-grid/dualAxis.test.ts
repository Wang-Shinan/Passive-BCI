import { describe, expect, it } from 'vitest'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { applyDualAxisPolicy, createGrid, smrLogitAxes, softGridAction, targetControlAxis, validSmrPrediction } from './engine'

const pred = {
  task: 'smr_dual_axis', output_semantics: 'smr_independent_binary_axes', received_at_ms: 100,
  class_names: ['left_hand', 'right_hand', 'tongue', 'rest'],
  probabilities: [.2, .8, .7, .3], logits: [10, 12, -18, -20],
} as ModelPrediction

describe('independent simultaneous binary axes', () => {
  it('accepts two distributions summing to two only in dual mode', () => {
    expect(validSmrPrediction(pred, 101, true)).toBe(true)
    expect(validSmrPrediction(pred, 101)).toBe(false)
    for (const patch of [{ task: 'smr_control' }, { output_semantics: 'smr_control_4' },
      { probabilities: [.1, .4, .35, .15] }, { logits: undefined }, { received_at_ms: -2000 }]) {
      expect(validSmrPrediction({ ...pred, ...patch }, 101, true)).toBe(false)
    }
  })
  it('masks the out-of-axis model and derives the known axis from target geometry', () => {
    const state = { ...createGrid(), cursor: { x: .5, y: .5 }, target: 5 }
    expect(applyDualAxisPolicy(state, { x: .8, y: -.9 }, 'target')).toEqual({ axes: { x: .8, y: 0 }, active: 'horizontal' })
    expect(applyDualAxisPolicy({ ...state, target: 1 }, { x: .8, y: -.9 }, 'target')).toEqual({ axes: { x: 0, y: -.9 }, active: 'vertical' })
    expect(applyDualAxisPolicy(state, { x: .8, y: -.9 }, 'vertical').axes).toEqual({ x: 0, y: -.9 })
    expect(applyDualAxisPolicy(state, { x: .8, y: -.9 }, 'simultaneous').axes).toEqual({ x: .8, y: -.9 })
  })
  it('holds a selected target axis until its coordinate reaches the target cell', () => {
    const state = { ...createGrid(), cursor: { x: .5, y: .5 }, target: 0 }
    expect(targetControlAxis(state, 'horizontal')).toBe('horizontal')
    expect(targetControlAxis({ ...state, cursor: { x: .18, y: .5 } }, 'horizontal')).toBe('vertical')
    expect(targetControlAxis({ ...state, cursor: { x: .5, y: .18 } }, 'vertical')).toBe('horizontal')
  })
  it('controls both axes independently and ignores per-model common logit offsets', () => {
    const axes = smrLogitAxes(pred)!
    expect(axes).toEqual({ x: 1, y: -1 })
    expect(smrLogitAxes({ ...pred, logits: [110, 112, 82, 80] })).toEqual(axes)
    const changed = smrLogitAxes({ ...pred, logits: [12, 10, -18, -20] })!
    expect(changed).toEqual({ x: -1, y: -1 })
    const action = softGridAction(createGrid(), axes, .4, 0).action
    expect(action.x).toBeGreaterThan(0)
    expect(action.y).toBeLessThan(0)
  })
})
