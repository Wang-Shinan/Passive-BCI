import { describe, expect, it } from 'vitest'
import { createGame } from '../engine'
import {
  RL_OBS_CHANNELS,
  RL_OBS_COLS,
  RL_OBS_ROWS,
} from './contracts'
import { encodeObservation, normalizeGravity, defaultMetadata } from './encode'
import { actionToIndex, describeRlAction } from './step'

describe('tetris rl encode', () => {
  it('encodes observation with expected shape', () => {
    const state = createGame(1)
    const obs = encodeObservation(state, 0.5)
    expect(obs.length).toBe(RL_OBS_CHANNELS * RL_OBS_ROWS * RL_OBS_COLS)
    expect(obs[0]).toBe(0)
  })

  it('maps actions to stable indices', () => {
    expect(actionToIndex('hardDrop')).toBe(6)
    expect(describeRlAction('rotateCW')).toContain('顺时针')
  })

  it('normalizes gravity using metadata bounds', () => {
    const meta = defaultMetadata({ gravityMin: 1, gravityMax: 6 })
    expect(normalizeGravity(3.5, meta)).toBeCloseTo(0.5)
  })
})
