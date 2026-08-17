import { describe, expect, it } from 'vitest'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { miControlActionForPrediction } from './miControl'

function prediction(classId: number, className: string): ModelPrediction {
  return {
    type: 'prediction',
    schema_version: 1,
    request_id: 'req-1',
    observation_id: 'obs-1',
    window_id: 1,
    segment_id: 'seg-1',
    class_id: classId,
    class_name: className,
    class_names: ['left_hand', 'right_hand', 'feet', 'tongue'],
    probabilities: [0.1, 0.1, 0.1, 0.7],
    confidence: 0.7,
    model_revision: 'base',
    online_update_step: 0,
    online_update_applied: false,
    prepare_latency_ms: 1,
    inference_latency_ms: 2,
    received_at_ms: 0,
  }
}

describe('tetris mi control mapping', () => {
  it('maps MI classes to board actions', () => {
    expect(miControlActionForPrediction(prediction(0, 'left_hand'))).toBe('left')
    expect(miControlActionForPrediction(prediction(1, 'right_hand'))).toBe('right')
    expect(miControlActionForPrediction(prediction(2, 'feet'))).toBe('rotate')
    expect(miControlActionForPrediction(prediction(3, 'tongue'))).toBe('none')
  })
})
