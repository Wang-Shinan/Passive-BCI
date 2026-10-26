import { describe, expect, it } from 'vitest'
import { VideoSwitchGate } from './control'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
const settings = { confidence: 0.7, confirmations: 3, cooldownMs: 5000 }
function prediction(at: number, label = 'left', confidence = 0.9): ModelPrediction {
  return { observation_id: String(at), received_at_ms: at, class_name: label, class_names: ['left', 'right'], confidence } as ModelPrediction
}
describe('video classification switching', () => {
  it('requires distinct consecutive predictions and does not retrigger a held class', () => {
    const gate = new VideoSwitchGate()
    expect(gate.accept(prediction(100), 100, settings)).toBeNull()
    expect(gate.accept(prediction(100), 110, settings)).toBeNull()
    expect(gate.accept(prediction(200), 200, settings)).toBeNull()
    expect(gate.accept(prediction(300), 300, settings)).toBe('left')
    expect(gate.accept(prediction(6000), 6000, settings)).toBeNull()
    expect(gate.accept(prediction(6100), 6100, settings)).toBeNull()
    expect(gate.accept(prediction(6200), 6200, settings)).toBeNull()
  })
  it('resets evidence after low confidence or a gap and rejects stale output', () => {
    const gate = new VideoSwitchGate()
    gate.accept(prediction(100), 100, settings)
    gate.accept(prediction(200, 'left', 0.2), 200, settings)
    expect(gate.accept(prediction(300), 300, settings)).toBeNull()
    expect(gate.accept(prediction(400), 400, settings)).toBeNull()
    expect(gate.accept(prediction(3000), 5000, settings)).toBeNull()
    expect(gate.accept(prediction(5100), 5100, settings)).toBeNull()
  })
  it('preserves cooldown across a playback interruption', () => {
    const gate = new VideoSwitchGate()
    const single = { ...settings, confirmations: 1 }
    expect(gate.accept(prediction(100), 100, single)).toBe('left')
    gate.suspend()
    expect(gate.accept(prediction(300, 'right'), 300, single)).toBeNull()
    expect(gate.accept(prediction(5200, 'right'), 5200, single)).toBe('right')
  })
  it('does not count old predictions or combine different classes', () => {
    const gate = new VideoSwitchGate()
    gate.accept(prediction(100), 100, settings)
    gate.accept(prediction(200, 'right'), 200, settings)
    expect(gate.accept(prediction(150, 'right'), 250, settings)).toBeNull()
    expect(gate.accept(prediction(300, 'right'), 300, settings)).toBeNull()
    expect(gate.accept(prediction(400, 'right'), 400, settings)).toBe('right')
  })
})
