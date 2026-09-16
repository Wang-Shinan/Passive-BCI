import { expect, it } from 'vitest'
import { TemporalEvidenceFilter, DEFAULT_TEMPORAL_FILTER } from './temporalEvidence'

it('requires five distinct observations and a majority; one confident outlier has one vote', () => {
  const f = new TemporalEvidenceFilter({ ...DEFAULT_TEMPORAL_FILTER, mode: 'vote', horizonSec: .5, stepSec: .1 })
  const observe = (id: string, p: number[]) => f.observe({ observationId: id, classNames: ['left', 'right'], probabilities: p })
  expect(observe('1', [.51, .49]).ready).toBe(false)
  observe('1', [.51, .49])
  observe('2', [.51, .49])
  observe('3', [.51, .49])
  expect(observe('4', [.01, .99]).ready).toBe(false)
  const d = observe('5', [.01, .99])
  expect(d.ready).toBe(true)
  expect(d.className).toBe('left')
  expect(d.confidence).toBe(.6)
  f.reset()
  expect(observe('6', [.9, .1]).ready).toBe(false)
})

it('does not authorize a tied vote', () => {
  const f = new TemporalEvidenceFilter({ ...DEFAULT_TEMPORAL_FILTER, mode: 'vote', horizonSec: .4, stepSec: .1 })
  for (let i = 0; i < 4; i++) {
    const d = f.observe({ observationId: String(i), classNames: ['left', 'right'], probabilities: i % 2 ? [.1, .9] : [.9, .1] })
    expect(d.ready).toBe(false)
  }
})
