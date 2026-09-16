import { describe, expect, it } from 'vitest'
import { LETTERS, generateTrials, scoreTrial, summarize } from './engine'

describe('N-back experiment', () => {
  it.each([1, 2, 3])('generates reproducible %i-back sequences without accidental targets', (n) => {
    const trials = generateTrials(n, 60, 1234)
    expect(trials).toEqual(generateTrials(n, 60, 1234))
    expect(trials).toHaveLength(60 + n)
    expect(trials.filter((t) => t.target)).toHaveLength(18)
    trials.forEach((trial, i) => {
      expect(trial.scored).toBe(i >= n)
      if (i >= n) expect(trial.target).toBe(trial.letter === trials[i - n]!.letter)
      expect(LETTERS).toContain(trial.letter)
    })
  })
  it('scores all four outcomes and excludes warmup responses from accuracy and RT', () => {
    const results = [
      scoreTrial({ letter: 'A', target: false, scored: false }, 0, 10),
      scoreTrial({ letter: 'A', target: true, scored: true }, 1, 400),
      scoreTrial({ letter: 'A', target: true, scored: true }, 2, null),
      scoreTrial({ letter: 'B', target: false, scored: true }, 3, 200),
      scoreTrial({ letter: 'C', target: false, scored: true }, 4, null),
    ]
    expect(results.map((r) => r.outcome)).toEqual(['warmup', 'hit', 'miss', 'false_alarm', 'correct_rejection'])
    expect(summarize(results)).toEqual({ total: 4, hits: 1, misses: 1, falseAlarms: 1, correctRejections: 1, accuracy: 0.5, meanHitRtMs: 400 })
    expect(summarize([]).accuracy).toBeNull()
  })
})
