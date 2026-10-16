import { describe, expect, it } from 'vitest'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import { cardinalDirectionAxes, cellAt, constrainToCorridor, createGrid, GRID_CURSOR_PAD, keyboardVelocity, randomTarget, smrCardinalLogitAxes, smrLogitAxes, softCorridorField, softGridAction, stepGrid, targetCenter, validSmrPrediction } from './engine'

describe('continuous grid task', () => {
  it('starts at the center of a 3 by 3 board with an unoccupied target', () => {
    const state = createGrid(3, () => 0.5)
    expect(state.cursor).toEqual({ x: 0.5, y: 0.5 })
    expect(state.n).toBe(3)
    expect(state.target).not.toBe(4)
  })

  it('samples every other cell exactly once with evenly spaced random values', () => {
    for (const n of [3, 4, 8]) {
      for (let occupied = 0; occupied < n * n; occupied++) {
        const targets = Array.from({ length: n * n - 1 }, (_, i) => randomTarget(n, occupied, () => (i + 0.5) / (n * n - 1)))
        expect(new Set(targets).size).toBe(n * n - 1)
        expect(targets).not.toContain(occupied)
        expect(Math.min(...targets)).toBeGreaterThanOrEqual(0)
        expect(Math.max(...targets)).toBeLessThan(n * n)
      }
    }
  })

  it('scores consecutive targets without recentering, rest or stopping motion', () => {
    const state = { ...createGrid(), cursor: { x: 0.66, y: 0.5 }, target: 5 }
    const hit = stepGrid(state, { x: 0.25, y: 0 }, 0.04, 1, () => 0.99)
    expect(hit.hits).toBe(1)
    expect(hit.cursor.x).toBeCloseTo(0.67)
    expect(hit.cursor.y).toBe(0.5)
    expect(hit.target).toBe(8)
    const moving = stepGrid(hit, { x: 0, y: 0.25 }, 0.04, 1)
    expect(moving.cursor.y).toBeCloseTo(0.51)
    let next = moving
    for (let i = 0; i < 17; i++) next = stepGrid(next, { x: 0, y: 0.25 }, 0.04, 1, () => 0)
    expect(next.hits).toBe(2)
    expect(next.target).toBe(0)
    expect(next.cursor.x).toBeCloseTo(0.67)
    expect(next.cursor.y).toBeCloseTo(0.68)
  })

  it('does not count an unlit cell and holds position without input', () => {
    const state = createGrid(3, () => 0)
    const next = stepGrid(state, { x: 0, y: 0 }, 0.02, 1)
    expect(next.cursor).toEqual(state.cursor)
    expect(next.target).toBe(state.target)
    expect(next.hits).toBe(0)
  })

  it('clamps both edges and caps catch-up time after a stalled frame', () => {
    const state = { ...createGrid(), cursor: { x: 0.98, y: 0.02 } }
    const next = stepGrid(state, { x: 1, y: -1 }, 60, 2)
    expect(next.cursor).toEqual({ x: 1 - GRID_CURSOR_PAD, y: GRID_CURSOR_PAD })
    expect(next.elapsed).toBe(0.05)
    expect(cellAt({ x: 1, y: 1 }, 3)).toBe(8)
    expect(stepGrid(state, { x: NaN, y: Infinity }, 0.02, 1).cursor).toEqual(state.cursor)
  })

  it('normalizes diagonal keys and cancels opposite directions', () => {
    expect(keyboardVelocity(new Set(['ArrowLeft', 'ArrowRight']))).toEqual({ x: 0, y: 0 })
    const diagonal = keyboardVelocity(new Set(['KeyW', 'KeyD']))
    expect(diagonal.x).toBeGreaterThan(0)
    expect(diagonal.y).toBeLessThan(0)
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(0.25)
  })
})

describe('optional fixed corridor', () => {
  const start = { x: 0.5, y: 0.5 }, end = { x: 5 / 6, y: 0.5 }

  it('preserves movement inside the full width and clips only excess lateral motion', () => {
    expect(constrainToCorridor({ x: 0.6, y: 0.54 }, start, end, 0.1)).toEqual({ x: 0.6, y: 0.54 })
    expect(constrainToCorridor({ x: 0.6, y: 0.7 }, start, end, 0.1)).toEqual({ x: 0.6, y: 0.55 })
    expect(constrainToCorridor({ x: 0.6, y: 0.3 }, start, end, 0.1)).toEqual({ x: 0.6, y: 0.45 })
  })

  it('handles diagonal, vertical and zero-length segments with rounded end caps', () => {
    const diagonal = constrainToCorridor({ x: 0.6, y: 0.3 }, { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }, 0.1)
    expect(Math.abs(diagonal.x - diagonal.y) / Math.SQRT2).toBeCloseTo(0.05)
    expect(constrainToCorridor({ x: 0.7, y: 0.6 }, start, { x: 0.5, y: 0.8 }, 0.1)).toEqual({ x: 0.55, y: 0.6 })
    expect(constrainToCorridor({ x: 0.3, y: 0.5 }, start, end, 0.1)).toEqual({ x: 0.45, y: 0.5 })
    expect(constrainToCorridor(start, start, start, 0)).toEqual(start)
    expect(constrainToCorridor({ x: 0.9, y: 0.5 }, start, start, 0.1)).toEqual({ x: 0.55, y: 0.5 })
  })

  it('does not move or auto-advance without a signal', () => {
    const state = { ...createGrid(), target: 5 }
    const next = stepGrid(state, { x: 0, y: 0 }, 0.04, 1, Math.random, 0.4)
    expect(next.cursor).toEqual(state.cursor)
    expect(next.hits).toBe(0)
  })

  it('keeps the anchor fixed under sustained sideways input; disabling restores free movement', () => {
    const initial = { ...createGrid(), target: 5 }
    let state = initial
    for (let i = 0; i < 100; i++) state = stepGrid(state, { x: 0, y: 1 }, 0.04, 1, Math.random, 0.3)
    expect(state.cursor.y).toBeCloseTo(0.55) // full width .3 cell / 3 rows = .1 board
    expect(state.cursor.x).toBeCloseTo(0.5)
    expect(state.corridorStart).toEqual(initial.cursor)
    expect(state.hits).toBe(0)
    expect(stepGrid(state, { x: 0, y: 1 }, 0.04, 1).cursor.y).toBeCloseTo(0.59)
  })

  it('retains position on a hit and establishes the next corridor there', () => {
    const initial = { ...createGrid(), target: 5, cursor: { x: 0.66, y: 0.5 } }
    const hit = stepGrid(initial, { x: 0.25, y: 0 }, 0.04, 1, () => 0.99, 0.4)
    expect(hit.hits).toBe(1)
    expect(hit.cursor.x).toBeCloseTo(0.67)
    expect(hit.target).toBe(8)
    expect(hit.corridorStart).toEqual(hit.cursor)
    expect(targetCenter(hit.target, hit.n)).toEqual({ x: 5 / 6, y: 5 / 6 })
  })

  it('keeps the cursor both in the corridor and inside the board for targets near edges', () => {
    for (const n of [3, 8]) for (const origin of [{ x: 0.018, y: 0.982 }, { x: 0.982, y: 0.018 }]) {
      let state = { ...createGrid(n), cursor: origin, corridorStart: origin, target: n * n - 1 }
      for (let i = 0; i < 100; i++) {
        state = stepGrid(state, { x: 1, y: 1 }, 0.05, 2, () => 0, 0.1)
        const projected = constrainToCorridor(state.cursor, state.corridorStart, targetCenter(state.target, n), 0.1 / n)
        expect(state.cursor.x).toBeCloseTo(projected.x)
        expect(state.cursor.y).toBeCloseTo(projected.y)
        expect(state.cursor.x).toBeGreaterThanOrEqual(GRID_CURSOR_PAD - 1e-12)
        expect(state.cursor.y).toBeLessThanOrEqual(1 - GRID_CURSOR_PAD + 1e-12)
      }
    }
  })
})

describe('logit plus weak inward field', () => {
  const state = { ...createGrid(), target: 5, cursor: { x: 0.6, y: 0.6 } }
  const start = { x: 0.5, y: 0.5 }, end = { x: 5 / 6, y: 0.5 }
  const head = { class_names: ['rest', 'tongue', 'right_hand', 'left_hand'], probabilities: [.25, .25, .25, .25], logits: [1, 3, 5, 1] }

  it('uses current logits, resolves class order and ignores common offsets', () => {
    expect(smrLogitAxes(head)).toEqual({ x: 2, y: -1 })
    expect(smrLogitAxes({ ...head, logits: head.logits.map(z => z + 100) })).toEqual({ x: 2, y: -1 })
    expect(smrLogitAxes({ ...head, logits: [NaN, 1, 2, 3] })).toBeNull()
    expect(smrLogitAxes({ ...head, logits: [1, 2] })).toBeNull()
  })

  it('recovers equivalent contrasts from probabilities when logits are absent', () => {
    const exps = head.logits.map(Math.exp), sum = exps.reduce((a, b) => a + b)
    const recovered = smrLogitAxes({ ...head, logits: undefined, probabilities: exps.map(z => z / sum) })!
    expect(recovered.x).toBeCloseTo(2)
    expect(recovered.y).toBeCloseTo(-1)
  })

  it('maps a four-class head to exactly one cardinal axis', () => {
    expect(cardinalDirectionAxes('left')).toEqual({ x: -1, y: 0 })
    expect(cardinalDirectionAxes('right')).toEqual({ x: 1, y: 0 })
    expect(cardinalDirectionAxes('up')).toEqual({ x: 0, y: -1 })
    expect(cardinalDirectionAxes('down')).toEqual({ x: 0, y: 1 })
    expect(smrCardinalLogitAxes(head)).toEqual({ x: 2, y: 0 })
    expect(smrCardinalLogitAxes({ ...head, logits: [5, 1, 1, 1] })).toEqual({ x: 0, y: 4 })
    expect(smrCardinalLogitAxes({ ...head, logits: [1, 1, 1, 1] })).toEqual({ x: 0, y: 0 })
  })

  it('has a zero-field interior and a smooth inward field on both sides and caps', () => {
    expect(softCorridorField({ x: .6, y: .53 }, start, end, .1, .25)).toEqual({ x: 0, y: 0 })
    const below = softCorridorField({ x: .6, y: .55 }, start, end, .1, .25)
    const above = softCorridorField({ x: .6, y: .45 }, start, end, .1, .25)
    expect(below.x).toBe(0)
    expect(below.y).toBeLessThan(0)
    expect(above.y).toBeCloseTo(-below.y)
    expect(softCorridorField({ x: .4, y: .5 }, start, end, .1, .25).x).toBeGreaterThan(0)
    const far = softCorridorField({ x: .6, y: .99 }, start, end, .1, .25)
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(.25)
    expect(Math.abs(far.y)).toBeGreaterThan(Math.abs(below.y))
    expect(softCorridorField({ x: .6, y: .99 }, start, end, .1, 0)).toEqual({ x: 0, y: 0 })
  })

  it('adds the field to logits before tanh, allowing strong outward intent to override it', () => {
    const mixed = softGridAction(state, { x: .4, y: .1 }, .3, .25)
    expect(mixed.action.x).toBeCloseTo(.25 * Math.tanh(.4 + mixed.field.x))
    expect(mixed.action.y).toBeCloseTo(.25 * Math.tanh(.1 + mixed.field.y))
    expect(mixed.action.y).toBeLessThan(0)
    expect(softGridAction(state, { x: 0, y: 2 }, .3, .25).action.y).toBeGreaterThan(0)
  })

  it('returns gradually into the boundary with valid neutral input, without hard clipping', () => {
    let next = state
    const first = stepGrid(next, softGridAction(next, { x: 0, y: 0 }, .3, .25).action, .04, 1)
    expect(first.cursor.y).toBeLessThan(.6)
    expect(first.cursor.y).toBeGreaterThan(.55)
    for (let i = 0; i < 250; i++) next = stepGrid(next, softGridAction(next, { x: 0, y: 0 }, .3, .25).action, .04, 1)
    expect(next.cursor.y).toBeLessThan(.55)
    expect(next.cursor.x).toBeCloseTo(.6)
    expect(next.corridorStart).toEqual(state.corridorStart)
  })

  it('freezes both neural and assistive motion when the signal is missing or invalid', () => {
    for (const input of [null, { x: NaN, y: 0 }]) {
      const mixed = softGridAction(state, input, .3, .25)
      expect(mixed.action).toEqual({ x: 0, y: 0 })
      expect(mixed.field).toEqual({ x: 0, y: 0 })
      expect(stepGrid(state, mixed.action, .04, 1).cursor).toEqual(state.cursor)
    }
  })
})

describe('SMR input gate', () => {
  const prediction = { task: 'smr_control', received_at_ms: 1000,
    class_names: ['left_hand', 'right_hand', 'tongue', 'rest'], probabilities: [0.7, 0.1, 0.1, 0.1] } as ModelPrediction
  it('accepts fresh SMR heads, including direction aliases', () => {
    expect(validSmrPrediction(prediction, 1200)).toBe(true)
    expect(validSmrPrediction({ ...prediction, class_names: ['left', 'right', 'up', 'down'] }, 1200)).toBe(true)
  })
  it('rejects stale, missing, unrelated or invalid input', () => {
    expect(validSmrPrediction(null, 1200)).toBe(false)
    expect(validSmrPrediction(prediction, 2600)).toBe(false)
    expect(validSmrPrediction({ ...prediction, task: 'tetris_action' }, 1200)).toBe(false)
    expect(validSmrPrediction({ ...prediction, probabilities: [NaN, 0, 0, 0] }, 1200)).toBe(false)
    expect(validSmrPrediction({ ...prediction, probabilities: [0, 0, 0, 0] }, 1200)).toBe(false)
    expect(validSmrPrediction({ ...prediction, probabilities: [1] }, 1200)).toBe(false)
    expect(validSmrPrediction({ ...prediction, logits: [NaN, 0, 0, 0] }, 1200)).toBe(false)
  })
})
