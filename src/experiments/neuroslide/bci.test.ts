import { describe, expect, it } from 'vitest'
import { BciCommandFilter, DEFAULT_FILTER, MI_MAPPING, EXISTING_SMR_MAPPING, mappingMatches,
  fromModelPrediction, mappingForLabels, migrateFilterConfig, type PredictionFrame } from './bci'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'

const labels = ['left_hand', 'right_hand', 'feet', 'tongue']
const frame = (id: number, winner = 0, roundId?: string): PredictionFrame => ({
  id: String(id), labels, probabilities: labels.map((_, i) => i === winner ? .94 : .02), receivedAt: id * 100, roundId,
})
const neutral = (id: number): PredictionFrame => ({ ...frame(id), probabilities: [.25, .25, .25, .25] })
const consume = (filter: BciCommandFilter, p: PredictionFrame, available = true) => filter.consume(p, p.receivedAt, available)
describe('BCI confirmation and deduplication', () => {
  const restFrame = (id: number, winner = 2, roundId?: string): PredictionFrame => ({
    ...frame(id, winner, roundId), labels: ['left_hand', 'right_hand', 'rest', 'tongue'],
  })
  it('uses the independent rest count without changing other class counts or deduplication', () => {
    const filter = new BciCommandFilter(EXISTING_SMR_MAPPING, { ...DEFAULT_FILTER, stableCount: 2, restStableCount: 4 })
    expect(consume(filter, restFrame(1))).toBeNull()
    expect(consume(filter, restFrame(1))).toBeNull()
    expect(consume(filter, restFrame(2))).toBeNull()
    expect(filter.message).toBe('rest 稳定确认 · 2/4')
    expect(consume(filter, restFrame(3))).toBeNull()
    expect(consume(filter, restFrame(4))).toBe('down')
    for (let i = 5; i < 10; i++) expect(consume(filter, restFrame(i))).toBeNull()
    for (let i = 10; i < 13; i++) consume(filter, { ...restFrame(i), probabilities: [.25, .25, .25, .25] })
    expect(consume(filter, restFrame(13, 0))).toBeNull()
    expect(consume(filter, restFrame(14, 0))).toBe('left')
  })
  it('applies the rest count by label even when rest is remapped, and allows a new independent trial', () => {
    const filter = new BciCommandFilter({ ...EXISTING_SMR_MAPPING, down: 'tongue', up: 'rest' }, { ...DEFAULT_FILTER, restStableCount: 1 })
    expect(consume(filter, restFrame(1, 2, 'a'))).toBe('up')
    expect(consume(filter, restFrame(2, 2, 'a'))).toBeNull()
    expect(consume(filter, restFrame(3, 2, 'b'))).toBe('up')
  })
  it('does not count interrupted rest evidence across classes or low confidence', () => {
    const filter = new BciCommandFilter(EXISTING_SMR_MAPPING, { ...DEFAULT_FILTER, restStableCount: 4 })
    consume(filter, restFrame(1)); consume(filter, restFrame(2))
    consume(filter, restFrame(3, 0))
    consume(filter, restFrame(4)); expect(filter.progress).toBe(1)
    consume(filter, { ...restFrame(5), probabilities: [.25, .25, .25, .25] })
    expect(filter.progress).toBe(0)
    expect(consume(filter, restFrame(6), false)).toBeNull()
    expect(consume(filter, restFrame(7))).toBeNull()
    expect(filter.progress).toBe(0)
  })
  it('migrates old settings without resetting the saved threshold or stable count', () => {
    const old = { threshold: .58, stableCount: 2, releaseThreshold: .45, releaseCount: 1, maxGapMs: 1500 }
    expect(migrateFilterConfig(old)).toEqual({ ...old, restStableCount: 2 })
    expect(migrateFilterConfig({ ...old, restStableCount: 7 }).restStableCount).toBe(7)
  })
  it.each([0, -1, 31, 1.5, NaN])('rejects invalid rest stable count %s', restStableCount => {
    expect(() => new BciCommandFilter(EXISTING_SMR_MAPPING, { ...DEFAULT_FILTER, restStableCount })).toThrow()
  })
  it('accepts fresh stable intent immediately after explicit start, without a low-confidence prerequisite', () => {
    const filter = new BciCommandFilter()
    consume(filter, frame(1), false)
    filter.begin(150)
    expect(consume(filter, frame(1))).toBeNull()
    expect(consume(filter, frame(2))).toBeNull()
    expect(consume(filter, frame(3))).toBeNull()
    expect(consume(filter, frame(4))).toBe('left')
    for (let i = 5; i < 20; i++) expect(consume(filter, frame(i))).toBeNull()
  })
  it('never turns near-uniform evidence into a direction even immediately after start', () => {
    const filter = new BciCommandFilter()
    filter.begin(0)
    for (let i = 1; i <= 30; i++) expect(consume(filter, { ...frame(i), probabilities: [.25, .26, .24, .25] })).toBeNull()
    expect(filter.message).toContain('26.0%')
  })
  it('automatically selects a known mapping by actual labels, leaving unknown labels configurable', () => {
    expect(mappingForLabels(['rest', 'tongue', 'right_hand', 'left_hand'])).toEqual(EXISTING_SMR_MAPPING)
    expect(mappingForLabels(labels)).toEqual(MI_MAPPING)
    expect(mappingForLabels(['a', 'b', 'c', 'd'])).toBeNull()
  })
  it.each([[0, 'left'], [1, 'right'], [2, 'down'], [3, 'up']] as const)('maps actual labels for class %i to %s', (winner, direction) => {
    const filter = new BciCommandFilter()
    expect(consume(filter, frame(1, winner))).toBeNull()
    expect(consume(filter, frame(2, winner))).toBeNull()
    expect(consume(filter, frame(3, winner))).toBe(direction)
  })
  it('repeated IDs neither accumulate stability nor move twice', () => {
    const filter = new BciCommandFilter()
    for (let i = 0; i < 20; i++) expect(consume(filter, frame(1))).toBeNull()
    consume(filter, frame(2)); expect(consume(filter, frame(3))).toBe('left')
    for (let i = 0; i < 20; i++) expect(consume(filter, frame(3))).toBeNull()
  })
  it('sustained predictions (including different high-confidence classes) never auto-repeat', () => {
    const filter = new BciCommandFilter()
    consume(filter, frame(1)); consume(filter, frame(2)); expect(consume(filter, frame(3))).toBe('left')
    for (let i = 4; i < 200; i++) expect(consume(filter, frame(i, i % 4))).toBeNull()
  })
  it('requires stable release then new confirmation, allowing the same direction again', () => {
    const filter = new BciCommandFilter()
    consume(filter, frame(1)); consume(filter, frame(2)); consume(filter, frame(3))
    consume(filter, neutral(4)); consume(filter, neutral(5)); consume(filter, frame(6))
    expect(consume(filter, neutral(7))).toBeNull()
    consume(filter, neutral(8)); consume(filter, neutral(9))
    consume(filter, frame(10)); consume(filter, frame(11)); expect(consume(filter, frame(12))).toBe('left')
  })
  it('blocks input and release evidence during slides, never buffering a new round', () => {
    const filter = new BciCommandFilter()
    for (let i = 1; i <= 3; i++) expect(consume(filter, frame(i, 1, 'busy-trial'), false)).toBeNull()
    for (let i = 4; i <= 6; i++) expect(consume(filter, frame(i, 1, 'busy-trial'))).toBeNull()
    consume(filter, frame(7, 1, 'new-trial')); consume(filter, frame(8, 1, 'new-trial'))
    expect(consume(filter, frame(9, 1, 'new-trial'))).toBe('right')
  })
  it('one command per independent round, same direction allowed in a later round', () => {
    const filter = new BciCommandFilter()
    consume(filter, frame(1, 2, 'a')); consume(filter, frame(2, 2, 'a'))
    expect(consume(filter, frame(3, 2, 'a'))).toBe('down')
    expect(consume(filter, frame(4, 2, 'a'))).toBeNull()
    consume(filter, frame(5, 2, 'b')); consume(filter, frame(6, 2, 'b'))
    expect(consume(filter, frame(7, 2, 'b'))).toBe('down')
    for (let i = 8; i < 12; i++) expect(consume(filter, frame(i, 2, 'a'))).toBeNull()
  })
  it('preserves duplicate history and closes in-progress rounds on restart/config changes', () => {
    const filter = new BciCommandFilter()
    consume(filter, frame(1, 0, 'a')); filter.configure(MI_MAPPING, DEFAULT_FILTER, 150)
    expect(consume(filter, frame(2, 0, 'a'))).toBeNull()
    expect(consume(filter, frame(1, 0, 'a'))).toBeNull()
    consume(filter, frame(3, 0, 'b')); consume(filter, frame(4, 0, 'b'))
    expect(consume(filter, frame(5, 0, 'b'))).toBe('left')
  })
  it('rejects stale, future, reordered and malformed probabilities', () => {
    const filter = new BciCommandFilter()
    expect(filter.consume(frame(1), 10000, true)).toBeNull()
    expect(filter.consume(frame(100), 100, true)).toBeNull()
    consume(filter, frame(5)); expect(consume(filter, frame(4))).toBeNull()
    expect(consume(filter, { ...frame(6), probabilities: [NaN, 0, 0, 0] })).toBeNull()
    expect(consume(filter, { ...frame(7), probabilities: [9, 1, 0, 0] })).toBeNull()
    expect(consume(filter, { ...frame(8), probabilities: [.1, .1, .1, .1] })).toBeNull()
    expect(consume(filter, { ...frame(9), id: '' })).toBeNull()
    expect(filter.progress).toBe(0)
  })
  it('resets stability on a different winner, low confidence or an excessive gap', () => {
    const filter = new BciCommandFilter()
    consume(filter, frame(1)); consume(filter, frame(2)); consume(filter, frame(3, 1))
    expect(filter.progress).toBe(1)
    consume(filter, neutral(4)); expect(filter.progress).toBe(0)
    consume(filter, frame(5)); consume(filter, frame(6)); expect(consume(filter, frame(30))).toBeNull()
    expect(filter.progress).toBe(1)
  })
  it('matches reordered class names, and never silently assumes rest means feet', () => {
    const reordered = { ...frame(1), labels: ['tongue', 'feet', 'right_hand', 'left_hand'], probabilities: [.94, .02, .02, .02] }
    const filter = new BciCommandFilter(MI_MAPPING, { ...DEFAULT_FILTER, stableCount: 1 })
    expect(consume(filter, reordered)).toBe('up')
    expect(mappingMatches(['left_hand', 'right_hand', 'tongue', 'rest'], MI_MAPPING)).toBe(false)
    expect(mappingMatches(['left_hand', 'right_hand', 'tongue', 'rest'], EXISTING_SMR_MAPPING)).toBe(true)
    expect(mappingMatches(labels, { ...MI_MAPPING, up: 'feet' })).toBe(false)
    expect(consume(new BciCommandFilter(), { ...frame(1), labels: ['left_hand', 'right_hand', 'tongue', 'rest'] })).toBeNull()
  })
  it('adapts the existing runtime by observation identity, not request count/class index', () => {
    const model = { observation_id: 'existing-id', class_names: labels, probabilities: [.1, .7, .1, .1], received_at_ms: 42 } as ModelPrediction
    expect(fromModelPrediction(model)).toEqual({ id: 'existing-id', labels, probabilities: [.1, .7, .1, .1], receivedAt: 42 })
  })
  it('validates configurable thresholds and stability counts', () => {
    expect(() => new BciCommandFilter(MI_MAPPING, { ...DEFAULT_FILTER, threshold: .2 })).toThrow()
    expect(() => new BciCommandFilter(MI_MAPPING, { ...DEFAULT_FILTER, stableCount: 1.5 })).toThrow()
    expect(() => new BciCommandFilter(MI_MAPPING, { ...DEFAULT_FILTER, releaseThreshold: .9 })).toThrow()
  })
  it('never arbitrarily resolves tied maximum classes at a lower configured threshold', () => {
    const filter = new BciCommandFilter(MI_MAPPING, { ...DEFAULT_FILTER, threshold: .4, releaseThreshold: .3, stableCount: 1 })
    expect(consume(filter, { ...frame(1), probabilities: [.45, .45, .05, .05] })).toBeNull()
  })
})
