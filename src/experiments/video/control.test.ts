import { describe, expect, it } from 'vitest'
import { AttentionSpeedControl, calibrateAttentionSpeed, DEFAULT_ATTENTION_SPEED, validAttentionSpeed, VideoSwitchGate } from './control'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import type { LiveFeatureSnapshot } from '../../lib/features/bandFeatures'
import { ATTENTION_VOTE_FEATURES, AttentionCalibrationRun, attentionVote, fitAttentionVote, parseAttentionVote } from './calibration'
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

describe('attention playback speed', () => {
  const config = DEFAULT_ATTENTION_SPEED
  const sample = (raw: number, at: number, sourceAt = at) => ({ raw, at, sourceAt })

  it('maps the existing attention score and limits changes to 0.1 per second', () => {
    const control = new AttentionSpeedControl()
    expect(control.accept(sample(1, 0), 0, config)).toEqual({ rate: 1.1, score: 50 })
    expect(control.accept(sample(1, 999), 999, config).rate).toBe(1.1)
    expect(control.accept(sample(1, 1000), 1000, config).rate).toBeCloseTo(1.125)
    for (let at = 2000; at <= 10000; at += 1000) control.accept(sample(100, at), at, config)
    expect(control.accept(sample(100, 11000), 11000, config).rate).toBe(config.maxRate)
    for (let at = 12000; at <= 22000; at += 1000) control.accept(sample(0, at), at, config)
    expect(control.accept(sample(0, 23000), 23000, config).rate).toBe(config.minRate)
  })

  it('does not reuse a window or jump when the target range excludes 1x', () => {
    const control = new AttentionSpeedControl()
    const highRange = { ...config, minRate: 1.5, maxRate: 2 }
    expect(control.accept(sample(100, 100), 100, highRange).rate).toBeCloseTo(1.1)
    expect(control.accept(sample(100, 100), 1100, highRange).rate).toBeCloseTo(1.1)
    expect(control.accept(sample(100, 50), 1100, highRange).rate).toBeCloseTo(1.1)
    expect(control.accept(sample(100, 1200), 1200, highRange).rate).toBeCloseTo(1.2)
  })

  it('restores 1x on invalid or stale features, including freshly recomputed old EEG', () => {
    const control = new AttentionSpeedControl()
    for (const input of [null, sample(NaN, 2000), sample(Infinity, 2000), sample(-1, 2000),
      sample(1, 2001), sample(1, 0), sample(1, 2000, 0), sample(1, 2000, 2001)]) {
      control.accept(sample(100, 1000), 1000, config)
      expect(control.accept(input, 2000, config)).toEqual({ rate: 1, score: null })
    }
    expect(control.accept(sample(0, 3000), 3000, config).rate).toBeCloseTo(.9)
  })

  it('validates the editable speed and score bounds', () => {
    expect(validAttentionSpeed(config)).toBe(true)
    for (const change of [{ minRate: .1 }, { maxRate: 5 }, { minRate: 2 }, { lowScore: -1 },
      { highScore: 101 }, { lowScore: 70 }, { maxRate: NaN }]) {
      const invalid = { ...config, ...change }
      expect(validAttentionSpeed(invalid)).toBe(false)
      expect(new AttentionSpeedControl().accept(sample(1, 0), 0, invalid)).toEqual({ rate: 1, score: null })
    }
  })

  it('calibrates a recent personal range and rejects short, flat or stale history', () => {
    const history: LiveFeatureSnapshot[] = Array.from({ length: 30 }, (_, i) => ({
      t: i * 200, nChannels: 16, windowSec: 1, values: { focus_score: (i + 1) / 10 },
    }))
    expect(calibrateAttentionSpeed(history, 6000)).toEqual([23, 74])
    expect(calibrateAttentionSpeed(history.slice(-10), 6000)).toBeNull()
    expect(calibrateAttentionSpeed(history, 8000)).toBeNull()
    expect(calibrateAttentionSpeed(history.map(p => ({ ...p, values: { focus_score: 1 } })), 6000)).toBeNull()
    expect(calibrateAttentionSpeed(history.map(p => ({ ...p, values: { focus_score: NaN } })), 6000)).toBeNull()
  })

  it('smoothly applies a voted target and resets if the vote or EEG becomes invalid', () => {
    const control = new AttentionSpeedControl()
    expect(control.accept(sample(1, 0), 0, config, 1.5).rate).toBeCloseTo(1.1)
    expect(control.accept(sample(1, 1000), 1000, config, 1.5).rate).toBeCloseTo(1.2)
    expect(control.accept(sample(1, 2000), 2000, config, 1).rate).toBeCloseTo(1.1)
    expect(control.accept(sample(1, 3000), 3000, config, NaN)).toEqual({ rate: 1, score: null })
    expect(control.accept(sample(1, 4000, 1000), 4000, config, 1.5)).toEqual({ rate: 1, score: null })
  })
})

describe('two-state attention calibration', () => {
  function window(at: number, focused = false): LiveFeatureSnapshot {
    return { t: at, nChannels: 16, windowSec: 1, values: {
      focus_score: focused ? 8 : 1, rel_power_alpha: focused ? .1 : .7,
      rel_power_theta: focused ? .2 : .6, spect_entropy: .5, hjorth_mobility: 1,
    } }
  }
  const examples = (focused: boolean) => Array.from({ length: 19 }, (_, i) => window((i + 1) * 1000, focused))

  it('collects 20 seconds per state with preparation and excludes boundary / overlapping windows', () => {
    const run = new AttentionCalibrationRun(0, 'S01:16ch')
    for (let t = 0; t <= 43000; t += 200) {
      const result = run.tick(window(t, t >= 23000), t, t, true)
      if (t === 19800) expect(result).toEqual({ phase: 'rest', remaining: 1 })
      if (t === 20000) expect(result).toEqual({ phase: 'prepare', remaining: 3 })
      if (t === 23000) expect(result).toEqual({ phase: 'focus', remaining: 20 })
      if (t === 43000) expect(result).toEqual({ phase: 'done', remaining: 0 })
    }
    expect(run.rest).toHaveLength(19)
    expect(run.focus).toHaveLength(19)
    expect(run.rest.map(p => p.t)).toEqual(Array.from({ length: 19 }, (_, i) => (i + 1) * 1000))
    expect(run.focus[0].t).toBe(24000)
    expect(fitAttentionVote(run.rest, run.focus, run.context).validation.balancedAccuracy).toBe(1)
  })

  it('does not count duplicate or invalid windows and stops on source gaps or a stalled timer', () => {
    const run = new AttentionCalibrationRun(0, 'test')
    run.tick(window(1000), 1000, 1000, true)
    run.tick(window(1000), 1250, 1250, true)
    run.tick({ ...window(2000), values: { ...window(2000).values, spect_entropy: NaN } }, 2000, 2000, true)
    expect(run.rest).toHaveLength(1)
    expect(() => run.tick(window(3000), 1000, 3000, true)).toThrow('中断')
    expect(() => new AttentionCalibrationRun(0, 'test').tick(window(2000), 2000, 2000, true)).toThrow('中断')
    expect(() => new AttentionCalibrationRun(0, 'test').tick(window(1000), 1000, 1000, false)).toThrow('中断')
  })

  it('learns both feature directions and a conservative vote threshold, then persists safely', () => {
    const model = fitAttentionVote(examples(false), examples(true), 'S01:16ch')
    expect(model.rules).toHaveLength(3)
    expect(model.rules.find(r => r.feature === 'focus_score')?.above).toBe(true)
    expect(model.rules.find(r => r.feature === 'rel_power_alpha')?.above).toBe(false)
    expect(model.minimumVotes).toBe(3)
    expect(model.validation).toEqual({ balancedAccuracy: 1, restRecall: 1, focusRecall: 1, restCount: 6, focusCount: 6 })
    expect(attentionVote(window(0, true).values, model)).toEqual({ votes: 3, total: 3, focused: true })
    expect(attentionVote(window(0, false).values, model)).toEqual({ votes: 0, total: 3, focused: false })
    expect(attentionVote({ ...window(0, true).values, focus_score: 1 }, model)?.focused).toBe(false)
    expect(attentionVote({ ...window(0, true).values, focus_score: NaN }, model)).toBeNull()
    expect(parseAttentionVote(JSON.stringify(model))).toEqual(model)
    expect(parseAttentionVote(JSON.stringify({ ...model, minimumVotes: 0 }))).toBeNull()
    expect(parseAttentionVote(JSON.stringify({ ...model, rules: [model.rules[0], model.rules[0]] }))).toBeNull()
    expect(parseAttentionVote('{invalid')).toBeNull()
  })

  it('uses validation only for evaluation, rejecting reversal in the later windows', () => {
    const reversed = examples(true).map((p, i) => i >= 13 ? { ...window(p.t, false) } : p)
    expect(() => fitAttentionVote(examples(false), reversed, 'test')).toThrow('后段验证区分不足')
    expect(() => fitAttentionVote(examples(false), examples(false), 'test')).toThrow('没有足够差异')
    expect(() => fitAttentionVote(examples(false).slice(0, 14), examples(true), 'test')).toThrow('至少 15')
  })

  it('can learn a reversed attention ratio without assuming high always means focus', () => {
    const rest = examples(false).map(p => ({ ...p, values: Object.fromEntries(ATTENTION_VOTE_FEATURES.map(k => [k, 1])) }))
    const focus = rest.map(p => ({ ...p, values: { ...p.values, focus_score: .1 } }))
    const model = fitAttentionVote(rest, focus, 'test')
    expect(model.rules).toHaveLength(1)
    expect(model.rules[0].above).toBe(false)
    expect(attentionVote(focus[0].values, model)?.focused).toBe(true)
  })
})
