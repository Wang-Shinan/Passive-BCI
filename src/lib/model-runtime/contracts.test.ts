import { describe, expect, it } from 'vitest'
import { parseServerMessage, predictionToOrdinalRating } from './contracts'

describe('model runtime protocol', () => {
  it('parses a complete prediction and preserves revision metadata', () => {
    const prediction = parseServerMessage(
      JSON.stringify({
        type: 'prediction',
        schema_version: 1,
        request_id: 'window-1',
        observation_id: 'obs-1',
        window_id: 7,
        segment_id: 'segment-1',
        class_id: 2,
        class_name: '好',
        class_names: ['差', '中', '好'],
        probabilities: [0.1, 0.2, 0.7],
        confidence: 0.7,
        model_revision: 'online-000003',
        online_update_step: 3,
        online_update_applied: true,
        prepare_latency_ms: 4,
        inference_latency_ms: 9,
        task: 'passive_rating',
        output_semantics: 'ordinal_rating_3',
      }),
    )
    expect(prediction.type).toBe('prediction')
    if (prediction.type !== 'prediction') throw new Error('unexpected message')
    expect(prediction.model_revision).toBe('online-000003')
    expect(predictionToOrdinalRating(prediction)).toBe(1)
  })

  it('does not infer reward semantics from class count alone', () => {
    const prediction = parseServerMessage(
      JSON.stringify({
        type: 'prediction',
        schema_version: 1,
        request_id: 'window-1',
        observation_id: 'obs-1',
        window_id: 1,
        segment_id: 'segment-1',
        class_id: 0,
        class_name: 'left',
        class_names: ['left', 'right', 'stop'],
        probabilities: [0.8, 0.1, 0.1],
        confidence: 0.8,
        model_revision: 'base',
        online_update_step: 0,
        online_update_applied: false,
        prepare_latency_ms: 1,
        inference_latency_ms: 2,
      }),
    )
    if (prediction.type !== 'prediction') throw new Error('unexpected message')
    expect(predictionToOrdinalRating(prediction)).toBeNull()
  })

  it('rejects malformed probability vectors', () => {
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: 'prediction',
          request_id: 'window-1',
          observation_id: 'obs-1',
          window_id: 1,
          segment_id: 'segment-1',
          class_id: 0,
          class_name: 'left',
          class_names: ['left', 'right'],
          probabilities: [1],
          confidence: 1,
        }),
      ),
    ).toThrow(/协议/)
  })

  it('accepts nested hello fields and string window_id from NCC', () => {
    const hello = parseServerMessage(
      JSON.stringify({
        type: 'hello',
        schema_version: 1,
        service: 'ncc-unified-runtime',
        model: {
          name: 'mi-50m',
          type: 'model_50m',
          task: 'motor_imagery',
          class_names: ['left', 'right', 'feet', 'rest'],
        },
        online: {
          model_revision: 'base',
          strategy: 'none',
        },
      }),
    )
    expect(hello).toMatchObject({
      type: 'hello',
      model_name: 'mi-50m',
      task: 'motor_imagery',
      model_revision: 'base',
      strategy: 'none',
      class_names: ['left', 'right', 'feet', 'rest'],
    })

    const prediction = parseServerMessage(
      JSON.stringify({
        type: 'prediction',
        schema_version: 1,
        request_id: 'window-1',
        observation_id: 'obs-1',
        window_id: '12',
        segment_id: 'segment-1',
        class_id: 1,
        class_name: 'right',
        class_names: ['left', 'right', 'feet', 'rest'],
        probabilities: [0.1, 0.7, 0.1, 0.1],
        confidence: 0.7,
        model_revision: 'base',
        online_update_step: 0,
        online_update_applied: false,
        prepare_latency_ms: 1,
        inference_latency_ms: 2,
      }),
    )
    expect(prediction.type).toBe('prediction')
    if (prediction.type !== 'prediction') throw new Error('unexpected message')
    expect(prediction.window_id).toBe(12)
    expect(predictionToOrdinalRating(prediction)).toBeNull()
  })
})
