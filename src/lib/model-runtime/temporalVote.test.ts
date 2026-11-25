import { expect, it } from 'vitest'
import { TemporalEvidenceFilter, DEFAULT_TEMPORAL_FILTER } from './temporalEvidence'

it('acts on the first observation and counts a confident outlier as one vote', () => {
  const f = new TemporalEvidenceFilter({ ...DEFAULT_TEMPORAL_FILTER, mode: 'vote', horizonSec: .5, stepSec: .1 })
  const observe = (id: string, p: number[]) => f.observe({ observationId: id, classNames: ['left', 'right'], probabilities: p })
  expect(observe('1', [.51, .49])).toMatchObject({ ready: true, className: 'left' })
  expect(observe('1', [.01, .99])).toMatchObject({ ready: true, className: 'left' })
  observe('2', [.51, .49])
  observe('3', [.51, .49])
  expect(observe('4', [.01, .99])).toMatchObject({ ready: true, className: 'left' })
  const d = observe('5', [.01, .99])
  expect(d.ready).toBe(true)
  expect(d.className).toBe('left')
  expect(d.confidence).toBe(.6)
  f.reset()
  expect(observe('6', [.9, .1])).toMatchObject({ ready: true, className: 'left' })
})

it('resolves an even split with the most recent vote for a leading class', () => {
  const f = new TemporalEvidenceFilter({ ...DEFAULT_TEMPORAL_FILTER, mode: 'vote' })
  const observe = (id: string, p: number[]) =>
    f.observe({ observationId: id, classNames: ['left', 'right', 'up'], probabilities: p })
  expect(observe('tie', [1 / 3, 1 / 3, 1 / 3]).ready).toBe(false)
  observe('1', [.05, .05, .9])
  observe('2', [.9, .05, .05])
  expect(observe('3', [.05, .9, .05])).toMatchObject({ ready: true, className: 'right', confidence: .25 })
  observe('4', [.9, .05, .05])
  observe('5', [.05, .9, .05])
  expect(observe('6', [.05, .05, .9])).toMatchObject({ ready: true, className: 'up' })
})
