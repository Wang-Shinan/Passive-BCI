import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import {
  TemporalEvidenceFilter,
  filterSequenceAccuracy,
  logitsFromProbabilities,
  rollingMeanLogitAccuracy,
  softmax,
  type LabeledWindow,
  type TemporalFilterConfig,
} from './temporalEvidence'

const NAMES = ['left_hand', 'right_hand', 'both_hand', 'rest']

function oneHotish(label: number, confidence: number, k = 4): number[] {
  const rest = (1 - confidence) / Math.max(1, k - 1)
  return Array.from({ length: k }, (_, i) => (i === label ? confidence : rest))
}

function noisySequence(opts: {
  seed: number
  accuracy: number
  hold: number
  blocks: number
  classes?: number
}): LabeledWindow[] {
  const rng = mulberry32(opts.seed)
  const k = opts.classes ?? 4
  const out: LabeledWindow[] = []
  for (let b = 0; b < opts.blocks; b++) {
    const label = b % k
    for (let t = 0; t < opts.hold; t++) {
      const correct = rng() < opts.accuracy
      let pred = label
      if (!correct) {
        pred = (label + 1 + Math.floor(rng() * (k - 1))) % k
      }
      const confidence = correct ? 0.55 + rng() * 0.12 : 0.34 + rng() * 0.16
      out.push({
        probabilities: oneHotish(pred, confidence, k),
        label,
        classNames: NAMES.slice(0, k),
      })
    }
  }
  return out
}

const baseConfig: TemporalFilterConfig = {
  mode: 'raw',
  alpha: 0.2,
  stayProb: 0.95,
  temperature: 1,
  horizonSec: 1,
  stepSec: 0.1,
}

describe('temporal evidence filter', () => {
  it('recovers a softmax up to a constant shift', () => {
    const logits = [1.2, -0.3, 0.4, -1.1]
    const probs = softmax(logits)
    const recovered = softmax(logitsFromProbabilities(probs))
    for (let i = 0; i < probs.length; i++) {
      expect(recovered[i]).toBeCloseTo(probs[i]!, 6)
    }
  })

  it('EMA on logits keeps the previous class through a single flicker', () => {
    const filter = new TemporalEvidenceFilter({ ...baseConfig, mode: 'ema', alpha: 0.2 })
    let decision = filter.observe({
      observationId: '1',
      classNames: NAMES,
      probabilities: [0.62, 0.16, 0.12, 0.1],
    })
    expect(decision.className).toBe('left_hand')
    for (let i = 2; i <= 6; i++) {
      decision = filter.observe({
        observationId: String(i),
        classNames: NAMES,
        probabilities: [0.58, 0.18, 0.14, 0.1],
      })
    }
    const flicker = filter.observe({
      observationId: '7',
      classNames: NAMES,
      probabilities: [0.12, 0.7, 0.1, 0.08],
    })
    expect(flicker.rawClassName).toBe('right_hand')
    expect(flicker.className).toBe('left_hand')
    expect(flicker.probabilities[0]!).toBeGreaterThan(flicker.probabilities[1]!)
  })

  it('HMM with high stay probability does not switch on one contrary window', () => {
    const filter = new TemporalEvidenceFilter({ ...baseConfig, mode: 'hmm', stayProb: 0.95 })
    for (let i = 0; i < 8; i++) {
      filter.observe({
        observationId: `l${i}`,
        classNames: NAMES,
        probabilities: [0.6, 0.18, 0.12, 0.1],
      })
    }
    const flipped = filter.observe({
      observationId: 'r',
      classNames: NAMES,
      probabilities: [0.08, 0.72, 0.12, 0.08],
    })
    expect(flipped.rawClassName).toBe('right_hand')
    expect(flipped.className).toBe('left_hand')
  })

  it('does not double-count the same observation id', () => {
    const filter = new TemporalEvidenceFilter({ ...baseConfig, mode: 'ema', alpha: 0.5 })
    const first = filter.observe({
      observationId: 'same',
      classNames: NAMES,
      probabilities: [0.7, 0.1, 0.1, 0.1],
    })
    const again = filter.observe({
      observationId: 'same',
      classNames: NAMES,
      probabilities: [0.1, 0.7, 0.1, 0.1],
    })
    expect(again.probabilities).toEqual(first.probabilities)
    expect(again.className).toBe('left_hand')
  })

  it('mean-logit voting raises accuracy as N grows on sticky 67.5% noise', () => {
    const sequence = noisySequence({
      seed: 20260824,
      accuracy: 0.675,
      hold: 24,
      blocks: 16,
    })
    const acc1 = rollingMeanLogitAccuracy(sequence, 1)
    const acc3 = rollingMeanLogitAccuracy(sequence, 3)
    const acc5 = rollingMeanLogitAccuracy(sequence, 5)
    const acc10 = rollingMeanLogitAccuracy(sequence, 10)
    expect(acc1).toBeGreaterThan(0.6)
    expect(acc1).toBeLessThan(0.75)
    expect(acc3).toBeGreaterThan(acc1)
    expect(acc5).toBeGreaterThan(acc3)
    expect(acc10).toBeGreaterThan(acc5)
    expect(acc10).toBeGreaterThan(0.85)
  })

  it('EMA and HMM beat raw argmax on the same sticky sequence', () => {
    const sequence = noisySequence({
      seed: 7,
      accuracy: 0.675,
      hold: 20,
      blocks: 12,
    })
    const raw = filterSequenceAccuracy(sequence, { ...baseConfig, mode: 'raw' })
    const ema = filterSequenceAccuracy(sequence, { ...baseConfig, mode: 'ema', alpha: 0.2 })
    const hmm = filterSequenceAccuracy(sequence, { ...baseConfig, mode: 'hmm', stayProb: 0.95 })
    const pooled = filterSequenceAccuracy(sequence, {
      ...baseConfig,
      mode: 'window',
      horizonSec: 0.5,
      stepSec: 0.1,
    })
    expect(ema).toBeGreaterThan(raw)
    expect(hmm).toBeGreaterThan(raw)
    expect(pooled).toBeGreaterThan(raw)
  })
})
