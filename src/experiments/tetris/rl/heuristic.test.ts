import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../../lib/rng'
import { createGame } from '../engine'
import { HeuristicPlanner, bestPlacementActions } from './heuristic'
import { rlStep } from './step'

describe('tetris heuristic teacher', () => {
  it('returns a DAS plan ending in hardDrop', () => {
    const plan = bestPlacementActions(createGame(7))
    expect(plan.length).toBeGreaterThan(0)
    expect(plan[plan.length - 1]).toBe('hardDrop')
    expect(plan.every((a) => ['left', 'right', 'rotateCW', 'hardDrop'].includes(a))).toBe(true)
  })

  it('clears lines like the BC teacher', () => {
    const seed = 100
    const rng = mulberry32(seed)
    let state = createGame(seed)
    const planner = new HeuristicPlanner()
    for (let i = 0; i < 200; i++) {
      const action = planner.act(state)
      state = rlStep(state, action, rng, { cellsPerSec: 3, instantAnim: true }).state
      if (state.gameOver) break
    }
    expect(state.lines).toBeGreaterThanOrEqual(5)
  })
})
