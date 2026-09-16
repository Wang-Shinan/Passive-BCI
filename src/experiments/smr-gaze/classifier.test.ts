import { describe, expect, it } from 'vitest'
import {
  DIRECTIONS, evaluateGaze, fitGazeModel, gazeFeatures, makePlan, parseGazeModel, predictGaze, recoverGazeModel,
  type Example,
} from './classifier'

const examples = (): Example[] => makePlan(42).map((trial) => {
  const c = DIRECTIONS.indexOf(trial.target)
  const x = [-30, 30, 0, 0][c]!
  const y = [0, 0, 30, -30][c]!
  const noise = Math.sin(trial.index * 2.7)
  return { ...trial, features: [x + noise, x, x - noise, y, y + noise, y - noise] }
})

describe('gaze calibration', () => {
  it('recovers complete trials from an aborted training run without using invalid trials', () => {
    const rows = examples().filter((e) => e.run === 1)
    const start = { type: 'session_start', subjectId: 'S03', data: { protocol: 'eeg-gaze-v1', mode: 'train', channels: ['Fp1', 'Fp2'], sampleRate: 100 } }
    const events = [start, ...rows.map((data) => ({ type: 'gaze_trial', subjectId: 'S03', data: { ...data, valid: true } })),
      { type: 'gaze_trial', data: { valid: false, features: [NaN] } }, { type: 'session_abort' }]
    expect(recoverGazeModel(events, 'S03').counts).toEqual([4, 4, 4, 4])
    expect(() => recoverGazeModel(events, 'S02')).toThrow('本被试')
    expect(() => recoverGazeModel([{ ...start, data: { ...start.data, mode: 'feedback' } }, ...events.slice(1)], 'S03')).toThrow('训练会话')
    expect(() => recoverGazeModel([...events, events[1]], 'S03')).toThrow('重复')
  })
  it('balances every run and reproduces the seed', () => {
    expect(makePlan(42)).toEqual(makePlan(42))
    expect(makePlan(42)).not.toEqual(makePlan(43))
    expect(makePlan(42)).toHaveLength(48)
    for (let run = 1; run <= 3; run++) {
      for (const direction of DIRECTIONS) {
        expect(makePlan(42).filter((t) => t.run === run && t.target === direction)).toHaveLength(4)
      }
    }
  })
  it('retains signed eye-potential offsets and cancels a per-channel baseline', () => {
    const baseline = [new Float32Array(100).fill(150), new Float32Array(100).fill(-80)]
    const target = [new Float32Array(300).fill(180), new Float32Array(300).fill(-100)]
    // An isolated spike is trimmed without discarding the gaze offset.
    target[0]![40] = 10000
    expect(gazeFeatures(baseline, target, 100)).toEqual([30, 30, 30, -20, -20, -20])
    expect(() => gazeFeatures(baseline, [new Float32Array(20), target[1]!], 100)).toThrow('不足')
    target[0]![20] = NaN
    expect(() => gazeFeatures(baseline, target, 100)).toThrow('无效')
  })
  it('decodes a held-out run and evaluates it without changing trained parameters', () => {
    const data = examples()
    const model = fitGazeModel(data.filter((e) => e.run < 3), 'S01', ['Fp1', 'Fp2'], 100)
    const before = JSON.stringify(model)
    const result = evaluateGaze(model, data.filter((e) => e.run === 3))
    expect(result.balancedAccuracy).toBe(1)
    expect(result.n).toBe(16)
    expect(model.counts).toEqual([8, 8, 8, 8])
    expect(JSON.stringify(model)).toBe(before)
    expect(predictGaze(model, [30, 30, 30, 0, 0, 0])).toBe('right')
  })
  it('regularizes flat channels, refuses missing classes, and flags incomplete evaluation', () => {
    const data = examples().map((e) => ({ ...e, features: [0, 0, 0, 0, 0, 0] }))
    const model = fitGazeModel(data, 'S01', ['Fp1', 'Fp2'], 100)
    expect(model.variance.every((v) => v >= 1 && Number.isFinite(v))).toBe(true)
    expect(() => fitGazeModel(data.filter((e) => e.target !== 'up'), 'S01', ['Fp1', 'Fp2'], 100)).toThrow('至少')
    expect(evaluateGaze(model, data.filter((e) => e.target !== 'up')).balancedAccuracy).toBeNull()
    expect(() => predictGaze(model, [NaN])).toThrow()
  })
  it('round-trips saved models and rejects damaged or incompatible payloads', () => {
    const model = fitGazeModel(examples(), 'S01', ['Fp1', 'Fp2'], 100)
    expect(parseGazeModel(JSON.stringify(model))).toEqual(model)
    expect(parseGazeModel('{')).toBeNull()
    expect(parseGazeModel(JSON.stringify({ ...model, variance: [0] }))).toBeNull()
    expect(parseGazeModel(JSON.stringify({ ...model, version: 2 }))).toBeNull()
  })
})
