import { describe, expect, it } from 'vitest'
import {
  PLANS,
  advancePhase,
  balancedTargets,
  buildTrials,
  createSession,
  currentTrial,
  finishTrial,
  scoreHint,
  scoresByTask,
  startSession,
  groupedPlan,
  resumeGroup,
} from './engine'
import { canLabelSmrHead, labelIndexForTarget } from './labels'
import type { TrialOutcome } from './smrControl'
import { reveCursorAxes } from './smrControl'

it('requires tongue imagery and never relabels the former both-hand class', () => {
  expect(canLabelSmrHead(['left_hand', 'right_hand', 'tongue', 'rest'])).toBe(true)
  expect(labelIndexForTarget(['left_hand', 'right_hand', 'tongue', 'rest'], 'up')).toBe(2)
  for (const oldName of ['both_hand', 'both_hands', 'both-hand', 'bothhands']) {
    expect(canLabelSmrHead(['left_hand', 'right_hand', oldName, 'rest'])).toBe(false)
    expect(labelIndexForTarget(['left_hand', 'right_hand', oldName, 'rest'], 'up')).toBeNull()
    expect(reveCursorAxes(['left_hand', 'right_hand', oldName, 'rest'], [0.1, 0.1, 0.1, 0.7])).toEqual({ zH: 0, zV: 0 })
  }
})

describe('session plan', () => {
  it('randomizes reproducibly with exactly equal directions within each group', () => {
    const plan = groupedPlan(3, 20)
    const trials = buildTrials(plan, 42)
    expect(trials).toEqual(buildTrials(plan, 42))
    expect(trials).not.toEqual(buildTrials(plan, 43))
    for (const run of [1, 2, 3]) {
      const group = trials.filter(t => t.run === run)
      expect(group).toHaveLength(20)
      expect(group.slice(0, 10).every(t => t.task === 'LR' && ['left', 'right'].includes(t.target))).toBe(true)
      expect(group.slice(10).every(t => t.task === 'UD' && ['up', 'down'].includes(t.target))).toBe(true)
      for (const direction of ['left', 'right', 'up', 'down']) {
        expect(trials.filter(t => t.run === run && t.target === direction)).toHaveLength(5)
      }
    }
    expect(() => groupedPlan(1, 7)).toThrow()
    expect(() => groupedPlan(0, 20)).toThrow()
    expect(buildTrials(PLANS.grouped, 42).every(t => t.task !== '2D')).toBe(true)
  })

  it('cannot advance across a group boundary without explicit resume', () => {
    let session = createSession(groupedPlan(2, 4), 42)
    session = { ...session, cursor: 3, phase: 'post' }
    session = advancePhase(session, 100)
    expect(session.phase).toBe('rest')
    expect(currentTrial(session)?.run).toBe(2)
    expect(advancePhase(session, 99999)).toEqual(session)
    session = resumeGroup(session, 100000)
    expect(session.phase).toBe('iti')
    expect(session.phaseStartedAt).toBe(100000)
    session = advancePhase({ ...session, cursor: 7, phase: 'post' }, 101000)
    expect(session.phase).toBe('done')
    expect(resumeGroup(session, 102000)).toEqual(session)
  })

  it('builds balanced LR/UD trials for the quick plan', () => {
    const trials = buildTrials(PLANS.quick, 7)
    expect(trials).toHaveLength(40)
    const lr = trials.filter((trial) => trial.task === 'LR')
    const left = lr.filter((trial) => trial.target === 'left')
    const right = lr.filter((trial) => trial.target === 'right')
    expect(left).toHaveLength(10)
    expect(right).toHaveLength(10)
    expect(balancedTargets('2D', 8, () => 0.1)).toHaveLength(8)
  })

  it('walks ITI → cue → feedback → post → next trial', () => {
    let session = startSession(createSession(PLANS.quick, 1), 0)
    expect(session.phase).toBe('iti')
    session = advancePhase(session, 2000)
    expect(session.phase).toBe('cue')
    expect(currentTrial(session)?.target).toBeTruthy()
    session = advancePhase(session, 4000)
    expect(session.phase).toBe('feedback')
    session = finishTrial(session, 'hit', 'left', 1.2, 5200)
    expect(session.phase).toBe('post')
    expect(session.trials[0]?.outcome).toBe('hit')
    session = advancePhase(session, 6200)
    expect(session.cursor).toBe(1)
    expect(session.phase).toBe('iti')
  })

  it('reports PVC by task', () => {
    const trials = buildTrials(PLANS.quick, 2).map((trial, index) => ({
      ...trial,
      outcome: (index < 20 ? (index % 2 === 0 ? 'hit' : 'miss') : 'timeout') as TrialOutcome,
    }))
    const scores = scoresByTask(trials)
    expect(scores[0]?.task).toBe('LR')
    expect(scores[0]?.pvc).toBeCloseTo(0.5)
    expect(scores[1]?.timeouts).toBe(20)
  })

  it('flags inverted LR when UD is already proficient', () => {
    const hint = scoreHint([
      {
        task: 'LR',
        pvc: 0.34,
        proficient: false,
        n: 40,
        hits: 11,
        misses: 21,
        timeouts: 8,
      },
      {
        task: 'UD',
        pvc: 0.83,
        proficient: true,
        n: 40,
        hits: 24,
        misses: 5,
        timeouts: 11,
      },
    ])
    expect(hint).toMatch(/符号反了/)
  })
})

describe('REVE label mapping', () => {
  it('matches Stieger classes onto common MI names', () => {
    const names = ['left_hand', 'right_hand', 'tongue', 'rest']
    expect(canLabelSmrHead(names)).toBe(true)
    expect(labelIndexForTarget(names, 'left')).toBe(0)
    expect(labelIndexForTarget(names, 'up')).toBe(2)
    expect(canLabelSmrHead(['任务一', '任务二', '任务三'])).toBe(false)
  })
})
