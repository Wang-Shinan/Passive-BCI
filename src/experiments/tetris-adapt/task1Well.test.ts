import { describe, expect, it } from 'vitest'
import { COLS } from '../tetris/engine'
import {
  applyTask1Action,
  extremeLegalX,
  spawnFeetTrial,
  spawnTask1Trial,
  task1Hit,
  tickTask1Gravity,
} from './task1Well'

describe('Task 1 Tetris-well hit conditions', () => {
  it('LR left is not a hit at spawn and hits after sliding to the leftmost legal column', () => {
    const state = spawnTask1Trial('LR', 'left', 11)
    expect(state.cue).toBe('left')
    expect(state.game.piece).toBeTruthy()
    expect(task1Hit(state)).toBe(false)
    expect(state.highlightCols.length).toBeGreaterThan(0)
    expect(Math.min(...state.highlightCols)).toBe(0)

    let current = state
    for (let i = 0; i < COLS; i++) current = applyTask1Action(current, 'left')
    expect(current.game.piece?.x).toBe(state.targetX)
    expect(task1Hit(current)).toBe(true)
  })

  it('LR right hits only at the rightmost legal x, not the opposite wall', () => {
    const state = spawnTask1Trial('LR', 'right', 21)
    expect(state.cue).toBe('right')
    expect(task1Hit(state)).toBe(false)

    let left = state
    for (let i = 0; i < COLS; i++) left = applyTask1Action(left, 'left')
    expect(task1Hit(left)).toBe(false)

    let right = state
    for (let i = 0; i < COLS; i++) right = applyTask1Action(right, 'right')
    expect(right.game.piece?.x).toBe(state.targetX)
    expect(task1Hit(right)).toBe(true)
    expect(Math.max(...state.highlightCols)).toBe(COLS - 1)
  })

  it('ignores rotate/drop during LR so the piece only slides', () => {
    const state = spawnTask1Trial('LR', 'left', 5)
    const rotated = applyTask1Action(state, 'rotate')
    const dropped = applyTask1Action(state, 'down')
    expect(rotated.game.piece?.rot).toBe(state.game.piece?.rot)
    expect(dropped.game.piece?.y).toBe(state.game.piece?.y)
  })

  it('UD rotate is not a hit at spawn and hits when the live piece matches the teacher orientation', () => {
    const state = spawnTask1Trial('UD', 'up', 33)
    expect(state.cue).toBe('rotate')
    expect(state.game.piece?.type).not.toBe('O')
    expect(state.teacher).toBeTruthy()
    expect(state.targetRot).not.toBe(state.game.piece?.rot)
    expect(task1Hit(state)).toBe(false)

    const moved = applyTask1Action(state, 'rotate')
    expect(moved.game.piece?.rot).toBe(state.targetRot)
    expect(task1Hit(moved)).toBe(true)
  })

  it('UD rotate ignores left/right/drop', () => {
    const state = spawnTask1Trial('UD', 'up', 8)
    const slid = applyTask1Action(applyTask1Action(state, 'left'), 'down')
    expect(slid.game.piece?.x).toBe(state.game.piece?.x)
    expect(slid.game.piece?.y).toBe(state.game.piece?.y)
    expect(task1Hit(slid)).toBe(false)
  })

  it('UD drop is not a hit at spawn and hits after a hard drop onto the marked landing', () => {
    const state = spawnTask1Trial('UD', 'down', 44)
    expect(state.cue).toBe('drop')
    expect(task1Hit(state)).toBe(false)
    expect(state.teacher?.y).toBe(state.targetY)
    expect(state.game.piece && state.game.piece.y < state.targetY).toBe(true)

    const landed = applyTask1Action(state, 'down')
    expect(landed.game.piece?.y).toBe(state.targetY)
    expect(task1Hit(landed)).toBe(true)
  })

  it('slow gravity does not reach the drop landing within a 6s feedback window', () => {
    let state = spawnTask1Trial('UD', 'down', 90)
    const startY = state.game.piece!.y
    for (let i = 0; i < Math.round(6 / 0.04); i++) {
      state = tickTask1Gravity(state, 0.04)
    }
    expect(state.game.piece!.y).toBeGreaterThanOrEqual(startY)
    expect(state.game.piece!.y).toBeLessThan(state.targetY)
    expect(task1Hit(state)).toBe(false)
  })

  it('computes leftmost/rightmost legal x from the tetris collider', () => {
    const state = spawnTask1Trial('LR', 'left', 2)
    const piece = state.game.piece!
    expect(extremeLegalX(state.game.board, piece, -1)).toBe(state.targetX)
    const right = spawnTask1Trial('LR', 'right', 2)
    expect(extremeLegalX(right.game.board, right.game.piece!, 1)).toBe(right.targetX)
  })

  it('feet collection shows a hard-drop landing and ignores control actions', () => {
    const state = spawnFeetTrial(44)
    expect(state.cue).toBe('hardDrop')
    expect(task1Hit(state)).toBe(false)
    expect(state.teacher?.y).toBe(state.targetY)
    const dropped = applyTask1Action(state, 'down')
    const slid = applyTask1Action(state, 'left')
    expect(dropped.game.piece?.y).toBe(state.game.piece?.y)
    expect(slid.game.piece?.x).toBe(state.game.piece?.x)
    expect(task1Hit(dropped)).toBe(false)
  })
})
