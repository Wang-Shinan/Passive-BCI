import { expect, it } from 'vitest'
import { LandingIntentGuard, harmsUsefulLanding } from './landingGuard'
import { createGame } from './engine'

it('blocks brief or alternating intent, permits sustained intent, resets after a gap', () => {
  const g = new LandingIntentGuard()
  expect(g.allow('piece', 'left', 0, true)).toBe(false)
  expect(g.allow('piece', 'right', 100, true)).toBe(false)
  expect(g.allow('piece', 'right', 300, true)).toBe(false)
  expect(g.allow('piece', 'right', 500, true)).toBe(true)
  expect(g.allow('piece', 'right', 1000, true)).toBe(false)
  expect(g.allow('piece', 'right', 1200, false)).toBe(false)
})

it('protects a near-ground line-filling I but leaves high pieces free', () => {
  const s = createGame(7)
  s.board[19] = [1, 1, 1, 0, 0, 0, 0, 1, 1, 1]
  s.piece = { type: 'I', rot: 0, x: 3, y: 16, fy: 0, matrix: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] }
  expect(harmsUsefulLanding(s, 'left')).toBe(true)
  s.piece!.y = 2
  expect(harmsUsefulLanding(s, 'left')).toBe(false)
})
