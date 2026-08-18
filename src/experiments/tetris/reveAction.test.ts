import { describe, expect, it } from 'vitest'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import {
  applyTetrisActionClass,
  describeTetrisAction,
  isTetrisActionPrediction,
  tetrisActionFromPrediction,
  tetrisActionLabelIndex,
  shouldAutoLabelRest,
} from './reveAction'
import { createGame } from './engine'

function prediction(classId: number, className: string, semantics = 'tetris_action_7'): ModelPrediction {
  return {
    type: 'prediction',
    schema_version: 1,
    request_id: 'req-1',
    observation_id: 'obs-1',
    window_id: 1,
    segment_id: 'seg-1',
    class_id: classId,
    class_name: className,
    class_names: ['rest', 'left', 'right', 'rotateCW', 'rotateCCW', 'softDrop', 'hardDrop'],
    probabilities: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.7],
    confidence: 0.7,
    model_revision: 'base',
    online_update_step: 0,
    online_update_applied: false,
    prepare_latency_ms: 1,
    inference_latency_ms: 2,
    received_at_ms: 0,
    output_semantics: semantics,
  }
}

describe('tetris REVE action mapping', () => {
  it('indexes keyboard actions for supervised labels', () => {
    expect(tetrisActionLabelIndex('rest')).toBe(0)
    expect(tetrisActionLabelIndex('left')).toBe(1)
    expect(tetrisActionLabelIndex('hardDrop')).toBe(6)
    expect(tetrisActionLabelIndex('unknown')).toBeNull()
  })

  it('caps rest labels so they cannot outnumber real actions', () => {
    expect(shouldAutoLabelRest(0, 0)).toBe(false)
    expect(shouldAutoLabelRest(1, 0)).toBe(true)
    expect(shouldAutoLabelRest(1, 1)).toBe(false)
    expect(shouldAutoLabelRest(4, 3)).toBe(true)
  })

  it('reads tetris_action_7 predictions and ignores ordinal heads', () => {
    expect(isTetrisActionPrediction(prediction(1, 'left'))).toBe(true)
    expect(tetrisActionFromPrediction(prediction(1, 'left'))).toBe('left')
    expect(tetrisActionFromPrediction(prediction(0, '差', 'ordinal_rating_3'))).toBeNull()
  })

  it('applies move/rotate and ignores rest', () => {
    const game = createGame(1)
    expect(applyTetrisActionClass(game, 'rest', () => 0)).toBeNull()
    const moved = applyTetrisActionClass(game, 'left', () => 0)
    expect(moved).not.toBeNull()
    expect(describeTetrisAction('rotateCCW')).toContain('逆时针')
  })
})
