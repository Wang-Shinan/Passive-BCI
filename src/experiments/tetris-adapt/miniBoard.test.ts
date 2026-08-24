import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../lib/rng'
import type { PieceType } from '../tetris/engine'
import {
  MINI_ROWS,
  applyOverlapAction,
  cellsMatch,
  cellsOf,
  legalPlacements,
  overlapHit,
  placementIsLegal,
  spawnOverlapTrial,
  subjectLanding,
} from './miniBoard'

const TYPES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

describe('overlap detection', () => {
  it('matches identical cell sets regardless of order', () => {
    expect(
      cellsMatch(
        [
          { c: 1, r: 10 },
          { c: 0, r: 10 },
        ],
        [
          { c: 0, r: 10 },
          { c: 1, r: 10 },
        ],
      ),
    ).toBe(true)
    expect(cellsMatch([{ c: 0, r: 10 }], [{ c: 1, r: 10 }])).toBe(false)
  })

  it('treats red landing == green teacher as a hit', () => {
    const rng = mulberry32(42)
    const state = spawnOverlapTrial(5, rng)
    const snapped = { ...state, subject: { ...state.teacher } }
    expect(overlapHit(snapped)).toBe(true)
    expect(cellsMatch(cellsOf(subjectLanding(snapped)), cellsOf(snapped.teacher))).toBe(true)
  })

  it('hits after shifting onto the teacher column with the same rotation', () => {
    const rng = mulberry32(5)
    const state = spawnOverlapTrial(5, rng)
    expect(state.subject.rot).toBe(state.teacher.rot)
    const dx = state.teacher.x - state.subject.x
    if (dx === 0) {
      expect(overlapHit(state)).toBe(true)
      return
    }
    let current = state
    const step = dx > 0 ? 'right' : 'left'
    for (let i = 0; i < Math.abs(dx) + 2; i++) {
      current = applyOverlapAction(current, step)
      if (overlapHit(current)) break
    }
    expect(overlapHit(current)).toBe(true)
  })

  it('is not a hit when the subject is on another column', () => {
    const rng = mulberry32(9)
    let state = spawnOverlapTrial(5, rng)
    for (let i = 0; i < 8; i++) {
      const moved = applyOverlapAction(state, 'left')
      if (subjectLanding(moved).x !== state.teacher.x) {
        state = moved
        break
      }
      state = applyOverlapAction(state, 'right')
    }
    if (subjectLanding(state).x !== state.teacher.x) {
      expect(overlapHit(state)).toBe(false)
    }
  })
})

describe('teacher placement legality', () => {
  it('only emits in-bounds landings for every piece on width 5 and 7', () => {
    for (const width of [5, 7] as const) {
      for (const type of TYPES) {
        const placements = legalPlacements(width, type)
        expect(placements.length).toBeGreaterThan(0)
        for (const placement of placements) {
          expect(placementIsLegal(width, placement)).toBe(true)
          expect(placement.cells.every((cell) => cell.c >= 0 && cell.c < width)).toBe(true)
          expect(placement.cells.every((cell) => cell.r >= 0 && cell.r < MINI_ROWS)).toBe(true)
        }
      }
    }
  })

  it('spawns a legal teacher pose and offsets the subject when a second column exists', () => {
    const rng = mulberry32(21)
    for (let i = 0; i < 30; i++) {
      const width = i % 2 === 0 ? 5 : 7
      const state = spawnOverlapTrial(width, rng)
      expect(
        placementIsLegal(width, {
          type: state.teacher.type,
          x: state.teacher.x,
          y: state.teacher.y,
          rot: state.teacher.rot,
          cells: cellsOf(state.teacher),
        }),
      ).toBe(true)
      expect(state.subject.rot).toBe(state.teacher.rot)
      const sameRot = legalPlacements(width, state.teacher.type).filter(
        (item) => item.rot === state.teacher.rot,
      )
      if (sameRot.length > 1) {
        expect(state.subject.x).not.toBe(state.teacher.x)
      }
    }
  })
})

