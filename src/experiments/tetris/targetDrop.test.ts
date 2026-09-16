import { expect, it } from 'vitest'
import { createGame } from './engine'
import { matchesTeacherTarget, tapSoftDrop } from './targetDrop'

it('taps down exactly one cell without changing fractional gravity or locking', () => {
  const s = createGame(7)
  const result = tapSoftDrop(s)
  expect(result.piece!.y).toBe(s.piece!.y + 1)
  expect(result.piece!.fy).toBe(s.piece!.fy)
  expect(result.score).toBe(s.score + 1)
  expect(tapSoftDrop({ ...s, paused: true }).piece).toBe(s.piece)
})

it('requires both target column and rotation, and stops when paused or displaced', () => {
  const s = createGame(7)
  const target = { x: s.piece!.x, rot: s.piece!.rot, rotSteps: 0, score: 0 }
  expect(matchesTeacherTarget(s, target)).toBe(true)
  expect(matchesTeacherTarget(s, { ...target, x: target.x + 1 })).toBe(false)
  expect(matchesTeacherTarget(s, { ...target, rot: (target.rot + 1) % 4 })).toBe(false)
  expect(matchesTeacherTarget({ ...s, paused: true }, target)).toBe(false)
  expect(matchesTeacherTarget(s, null)).toBe(false)
})
