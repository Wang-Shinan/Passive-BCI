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
} from './engine'
import { canLabelSmrHead, labelIndexForTarget } from './labels'
import type { TrialOutcome } from './smrControl'

describe('session plan', () => {
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
    const names = ['left_hand', 'right_hand', 'both_hand', 'rest']
    expect(canLabelSmrHead(names)).toBe(true)
    expect(labelIndexForTarget(names, 'left')).toBe(0)
    expect(labelIndexForTarget(names, 'up')).toBe(2)
    expect(canLabelSmrHead(['任务一', '任务二', '任务三'])).toBe(false)
  })
})
