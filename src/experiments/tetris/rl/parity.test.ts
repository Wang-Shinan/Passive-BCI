import { describe, expect, it } from 'vitest'
import { createGame } from '../engine'
import { mulberry32 } from '../../../lib/rng'
import { boardFingerprint } from './encode'
import { actionFromIndex, rlStep } from './step'
import { RL_ACTION_NAMES } from './contracts'
import parityFixtures from '../../../../tetris-rl/fixtures/parity_trajectories.json'

interface ParityFixture {
  name: string
  seed: number
  cellsPerSec: number
  actions: string[]
  fingerprints: string[]
}

describe('tetris rl parity', () => {
  it('exports action names in stable order', () => {
    expect(RL_ACTION_NAMES).toEqual([
      'noop',
      'left',
      'right',
      'rotateCW',
      'rotateCCW',
      'softDrop',
      'hardDrop',
    ])
  })

  for (const fixture of parityFixtures as ParityFixture[]) {
    it(`matches trajectory ${fixture.name}`, () => {
      const rng = mulberry32(fixture.seed)
      let state = createGame(fixture.seed)
      const fps: string[] = [boardFingerprint(state)]

      for (const actionName of fixture.actions) {
        const action = actionFromIndex(
          RL_ACTION_NAMES.indexOf(actionName as (typeof RL_ACTION_NAMES)[number]),
        )
        const result = rlStep(state, action, rng, {
          cellsPerSec: fixture.cellsPerSec,
          instantAnim: true,
        })
        state = result.state
        fps.push(boardFingerprint(state))
      }

      expect(fps).toEqual(fixture.fingerprints)
    })
  }
})
