import { describe, expect, it } from 'vitest'
import {
  PLANS,
  advancePhase,
  buildTrials,
  createSession,
  cueLabel,
  currentTrial,
  finishTrial,
  instructionFor,
  overallHitRate,
  planTrialTotal,
  scoresByBlock,
  startSession,
} from './engine'

describe('tetris-adapt plans', () => {
  it('quick is LR20 + UD20 + feet20 + W5 20 + W7 20', () => {
    const trials = buildTrials(PLANS.quick, 11)
    expect(planTrialTotal(PLANS.quick)).toBe(100)
    expect(trials).toHaveLength(100)
    expect(trials.filter((trial) => trial.kind === 'smr' && trial.task === 'LR')).toHaveLength(20)
    expect(trials.filter((trial) => trial.kind === 'smr' && trial.task === 'UD')).toHaveLength(20)
    expect(trials.filter((trial) => trial.kind === 'collect' && trial.className === 'feet')).toHaveLength(20)
    expect(trials.filter((trial) => trial.kind === 'overlap' && trial.boardWidth === 5)).toHaveLength(20)
    expect(trials.filter((trial) => trial.kind === 'overlap' && trial.boardWidth === 7)).toHaveLength(20)
    expect(trials.slice(0, 20).every((trial) => trial.task === 'LR')).toBe(true)
    expect(trials.slice(20, 40).every((trial) => trial.task === 'UD')).toBe(true)
    expect(trials.slice(40, 60).every((trial) => trial.kind === 'collect')).toBe(true)
    expect(trials.slice(60, 80).every((trial) => trial.boardWidth === 5)).toBe(true)
    expect(trials.slice(80, 100).every((trial) => trial.boardWidth === 7)).toBe(true)
  })

  it('standard doubles each block to 40', () => {
    const trials = buildTrials(PLANS.standard, 3)
    expect(planTrialTotal(PLANS.standard)).toBe(200)
    expect(trials).toHaveLength(200)
    expect(trials.filter((trial) => trial.task === 'LR')).toHaveLength(40)
    expect(trials.filter((trial) => trial.task === 'UD')).toHaveLength(40)
    expect(trials.filter((trial) => trial.kind === 'collect')).toHaveLength(40)
    expect(trials.filter((trial) => trial.boardWidth === 5)).toHaveLength(40)
    expect(trials.filter((trial) => trial.boardWidth === 7)).toHaveLength(40)
  })

  it('balances left/right within the LR block', () => {
    const lr = buildTrials(PLANS.quick, 7).filter((trial) => trial.task === 'LR')
    expect(lr.filter((trial) => trial.target === 'left')).toHaveLength(10)
    expect(lr.filter((trial) => trial.target === 'right')).toHaveLength(10)
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

  it('reports hit rate by block', () => {
    const trials = buildTrials(PLANS.quick, 2).map((trial, index) => ({
      ...trial,
      outcome: index < 10 ? ('hit' as const) : index < 20 ? ('timeout' as const) : null,
    }))
    const scores = scoresByBlock(trials)
    expect(scores[0]?.key).toBe('LR')
    expect(scores[0]?.hits).toBe(10)
    expect(scores[0]?.timeouts).toBe(10)
    expect(overallHitRate(trials)).toBeCloseTo(0.5)
  })

  it('uses Tetris action language for Task 1 cues', () => {
    const trials = buildTrials(PLANS.quick, 1)
    const left = trials.find((trial) => trial.target === 'left')!
    const right = trials.find((trial) => trial.target === 'right')!
    const up = trials.find((trial) => trial.target === 'up')!
    const down = trials.find((trial) => trial.target === 'down')!
    expect(cueLabel(left)).toBe('把方块移到左侧')
    expect(cueLabel(right)).toBe('把方块移到右侧')
    expect(cueLabel(up)).toBe('旋转')
    expect(cueLabel(down)).toBe('下落，对齐落点')
    expect(instructionFor(up)).toContain('旋转')
    expect(instructionFor(down)).toContain('下落')
    expect(instructionFor(null)).not.toMatch(/黄条|粉球|Stieger/)
    const feet = trials.find((trial) => trial.kind === 'collect')!
    expect(feet.className).toBe('feet')
    expect(feet.intendedAction).toBe('hardDrop')
    expect(feet.control).toBe(false)
    expect(cueLabel(feet)).toContain('速降')
    expect(instructionFor(feet)).toMatch(/只采|不控/)
  })

  it('does not count feet collection toward hit rate', () => {
    const trials = buildTrials(PLANS.quick, 2).map((trial, index) => ({
      ...trial,
      outcome:
        trial.kind === 'collect'
          ? ('recorded' as const)
          : index < 10
            ? ('hit' as const)
            : index < 20
              ? ('timeout' as const)
              : null,
    }))
    const scores = scoresByBlock(trials)
    expect(scores[0]?.key).toBe('LR')
    expect(scores[0]?.hits).toBe(10)
    expect(scores[0]?.timeouts).toBe(10)
    const feet = scores.find((row) => row.key === 'FEET')
    expect(feet?.recorded).toBe(20)
    expect(feet?.rate).toBeNull()
    expect(overallHitRate(trials)).toBeCloseTo(0.5)
  })
})
