import { describe, expect, it } from 'vitest'
import { boardFeatures } from './boardFeatures'
import {
  applyTeacherFollow,
  clampFollowMoves,
  clampFollowSteps,
  collabTeacherDecision,
  executeMiInCollab,
  executeRlInCollab,
  followPieceKey,
  noteFollowHumanMove,
  packingScore,
  teacherFollowActions,
} from './collab'
import { COLS, ROWS, createGame, ghostY, holdOrLock, type GameState } from './engine'

const SEARCH = { gravity: 3, horizon: 10 }

describe('tetris collab filters', () => {
  it('does not execute RL translates or hard drops', () => {
    expect(executeRlInCollab('rotateCW')).toBe('rotateCW')
    expect(executeRlInCollab('left')).toBe('noop')
    expect(executeRlInCollab('right')).toBe('noop')
    expect(executeRlInCollab('hardDrop')).toBe('noop')
  })

  it('lets SMR keep left/right and drops rotate/rest', () => {
    expect(executeMiInCollab('left')).toBe('left')
    expect(executeMiInCollab('right')).toBe('right')
    expect(executeMiInCollab('rotate')).toBe('none')
  })
})

function fakeLocked(cells: Array<[number, number]>): GameState {
  const board = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0))
  for (const [r, c] of cells) board[r]![c] = 1
  return {
    board,
    piece: null,
    next: 'I',
    bag: [],
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    paused: false,
    lockTimer: 0,
    anim: null,
  }
}

describe('collab packing score', () => {
  it('prefers filling a hole over raising the stack', () => {
    const before = boardFeatures(fakeLocked([[19, 0], [18, 1]]).board)
    const filled = packingScore(fakeLocked([[19, 0], [18, 1], [19, 1]]), before)
    const stacked = packingScore(fakeLocked([[19, 0], [18, 1], [17, 0]]), before)
    expect(filled).toBeGreaterThan(stacked)
  })
})

describe('collab local packing', () => {
  it('only emits rotate or wait, never hardDrop', () => {
    const decision = collabTeacherDecision(createGame(7), SEARCH)
    expect(['noop', 'rotateCW', 'rotateCCW']).toContain(decision.action)
    expect(decision.action).not.toBe('hardDrop')
    expect(decision.expected).not.toBeNull()
    expect(Number.isFinite(decision.expected)).toBe(true)
  })

  it('keeps a flat I on an empty board instead of standing it up', () => {
    let found = 0
    for (let seed = 1; seed <= 40; seed++) {
      const state = createGame(seed)
      if (state.piece?.type !== 'I') continue
      found++
      expect(collabTeacherDecision(state, SEARCH).action).toBe('noop')
    }
    expect(found).toBeGreaterThan(0)
  })
})

describe('collab follow burst', () => {
  it('clamps the human and teacher budgets', () => {
    expect(clampFollowMoves(0)).toBe(1)
    expect(clampFollowMoves(99)).toBe(8)
    expect(clampFollowSteps(0)).toBe(1)
    expect(clampFollowSteps(99)).toBe(8)
    expect(clampFollowSteps(3)).toBe(3)
  })

  it('fires the teacher only after m human slides', () => {
    const key = followPieceKey(createGame(7))
    const first = noteFollowHumanMove({
      pieceKey: key,
      prevPieceKey: key,
      humanCount: 0,
      humanMoves: 2,
    })
    expect(first).toEqual({ pieceKey: key, humanCount: 1, teacherNow: false })
    const second = noteFollowHumanMove({
      pieceKey: key,
      prevPieceKey: first.pieceKey,
      humanCount: first.humanCount,
      humanMoves: 2,
    })
    expect(second.teacherNow).toBe(true)
    expect(second.humanCount).toBe(0)
  })

  it('keeps a grounded piece movable until the follow lock delay elapses', () => {
    const spawned = createGame(7)
    expect(spawned.piece).not.toBeNull()
    const grounded = {
      ...spawned,
      piece: { ...spawned.piece!, y: ghostY(spawned.board, spawned.piece!), fy: 0 },
    }
    const held = holdOrLock(grounded, () => 0.5, 100, 800)
    expect(held.state.piece).not.toBeNull()
    expect(held.events).toEqual([])
    const locked = holdOrLock(held.state, () => 0.5, 800, 800)
    expect(locked.events.some((event) => event.type === 'lock')).toBe(true)
  })

  it('does not spend the n budget on rotations and never hard-drops', () => {
    const actions = teacherFollowActions(createGame(7), 3)
    const laterals = actions.filter((action) => action === 'left' || action === 'right')
    expect(laterals.length).toBeLessThanOrEqual(3)
    expect(actions).not.toContain('hardDrop')
    const burst = applyTeacherFollow(createGame(7), 3, () => 0.5)
    expect(burst.actions.filter((action) => action === 'left' || action === 'right').length).toBeLessThanOrEqual(3)
    expect(burst.actions).not.toContain('hardDrop')
    expect(burst.state.piece).not.toBeNull()
  })
})
