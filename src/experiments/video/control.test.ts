import { describe, expect, it } from 'vitest'
import { VideoSwitchGate, playbackRateForControl, playbackRateForThreshold } from './control'
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

describe('decision modes', () => {
  it('vote: fires when the class holds the required fraction of the window', () => {
    const gate = new VideoSwitchGate()
    const vote = { confidence: 0.7, confirmations: 3, cooldownMs: 0, mode: 'vote' as const, voteWindow: 5, voteFraction: 0.6 }
    // window must fill first: [l,r,l,r,l] at 500 → left 3/5 ≥ 0.6
    expect(gate.accept(prediction(100, 'left'), 100, vote)).toBeNull()
    expect(gate.accept(prediction(200, 'right'), 200, vote)).toBeNull()
    expect(gate.accept(prediction(300, 'left'), 300, vote)).toBeNull()
    expect(gate.accept(prediction(400, 'right'), 400, vote)).toBeNull()
    expect(gate.accept(prediction(500, 'left'), 500, vote)).toBe('left')
    // latched: same class does not retrigger
    expect(gate.accept(prediction(600, 'left'), 600, vote)).toBeNull()
  })
  it('direct: every fresh confident prediction switches once per class', () => {
    const gate = new VideoSwitchGate()
    const direct = { confidence: 0.7, confirmations: 5, cooldownMs: 0, mode: 'direct' as const }
    expect(gate.accept(prediction(100, 'left'), 100, direct)).toBe('left')
    expect(gate.accept(prediction(200, 'left'), 200, direct)).toBeNull()
    expect(gate.accept(prediction(300, 'right'), 300, direct)).toBe('right')
    expect(gate.accept(prediction(400, 'left', 0.2), 400, direct)).toBeNull()
  })
  it('streak mode keeps the original consecutive-confirmation behavior', () => {
    const gate = new VideoSwitchGate()
    const streak = { confidence: 0.7, confirmations: 3, cooldownMs: 0, mode: 'streak' as const }
    expect(gate.accept(prediction(100, 'left'), 100, streak)).toBeNull()
    expect(gate.accept(prediction(200, 'right'), 200, streak)).toBeNull()
    expect(gate.accept(prediction(300, 'left'), 300, streak)).toBeNull()
    expect(gate.accept(prediction(400, 'left'), 400, streak)).toBeNull()
    expect(gate.accept(prediction(500, 'left'), 500, streak)).toBe('left')
  })
})

describe('playbackRateForControl', () => {
  it('maps the control channel linearly into the configured rate band', () => {
    expect(playbackRateForControl(0, 0.25, 3)).toBeCloseTo(0.25)
    expect(playbackRateForControl(50, 0.25, 3)).toBeCloseTo(1.625)
    expect(playbackRateForControl(100, 0.25, 3)).toBeCloseTo(3)
  })
  it('maps live control values into the enabled 0.5–2 band over a 0–100 output range', () => {
    expect(playbackRateForControl(40, 0.5, 2, 0, 100)).toBeCloseTo(1.1)
    expect(playbackRateForControl(67, 0.5, 2, 0, 100)).toBeCloseTo(1.505)
    expect(playbackRateForControl(32, 0.5, 2, 0, 100)).toBeCloseTo(0.98)
    expect(playbackRateForControl(0, 0.5, 2, 0, 100)).toBeCloseTo(0.5)
    expect(playbackRateForControl(50, 0.5, 2, 0, 100)).toBeCloseTo(1.25)
    expect(playbackRateForControl(100, 0.5, 2, 0, 100)).toBeCloseTo(2)
  })
  it('clamps out-of-range control values to the band edges', () => {
    expect(playbackRateForControl(174, 0.25, 3)).toBeCloseTo(3)
    expect(playbackRateForControl(-20, 0.5, 2)).toBeCloseTo(0.5)
  })
  it('normalizes against the driver output range instead of assuming 0-100', () => {
    expect(playbackRateForControl(150, 0.25, 3, 0, 300)).toBeCloseTo(1.625)
    expect(playbackRateForControl(25, 0.25, 3, 100, 0)).toBeCloseTo(0.25 + 0.75 * 2.75)
  })
  it('clamps the final rate to the supported 0.25-3.00 band', () => {
    expect(playbackRateForControl(100, 1, 8)).toBe(3)
    expect(playbackRateForControl(0, 0.1, 1)).toBe(0.25)
  })
  it('falls back to mid-rate for NaN control or a degenerate output range', () => {
    expect(playbackRateForControl(NaN, 0.5, 2)).toBeCloseTo(1.25)
    expect(playbackRateForControl(50, 0.5, 2, 7, 7)).toBeCloseTo(1.25)
  })
})

describe('playbackRateForThreshold', () => {
  it('is a two-bucket rate: below 1×, at or above 2×', () => {
    expect(playbackRateForThreshold(49, 50)).toBe(1)
    expect(playbackRateForThreshold(50, 50)).toBe(2)
    expect(playbackRateForThreshold(51, 50)).toBe(2)
    expect(playbackRateForThreshold(40, 50)).toBe(1)
    expect(playbackRateForThreshold(67, 50)).toBe(2)
    expect(playbackRateForThreshold(32, 50)).toBe(1)
  })
  it('handles edge thresholds', () => {
    expect(playbackRateForThreshold(0, 0)).toBe(2)
    expect(playbackRateForThreshold(100, 100)).toBe(2)
    expect(playbackRateForThreshold(99, 100)).toBe(1)
    expect(playbackRateForThreshold(0, 100)).toBe(1)
  })
  it('falls back to 1× for non-finite inputs', () => {
    expect(playbackRateForThreshold(NaN, 50)).toBe(1)
    expect(playbackRateForThreshold(50, NaN)).toBe(1)
    expect(playbackRateForThreshold(Infinity, 50)).toBe(1)
  })
})
