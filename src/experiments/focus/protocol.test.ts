import { describe, expect, it } from 'vitest'
import { createFocusPlan, DEFAULT_FOCUS_CONFIG, focusInterval, resolveFocusChannels, validateFocusConfig } from './protocol'

describe('cued focus acquisition', () => {
  it('balances the full session and short blocks reproducibly', () => {
    const config = { ...DEFAULT_FOCUS_CONFIG, trials: 22 }
    const plan = createFocusPlan(config, 42)
    expect(plan).toEqual(createFocusPlan(config, 42))
    expect(plan).not.toEqual(createFocusPlan(config, 43))
    expect(plan.filter(label => label === 'focus')).toHaveLength(11)
    for (let i = 0; i < plan.length; i += 4) {
      const block = plan.slice(i, i + 4)
      expect(block.filter(label => label === 'focus')).toHaveLength(block.length / 2)
    }
  })
  it('rejects plans that cannot provide balanced, bounded trials', () => {
    for (const config of [{ trials: 3 }, { trials: 0 }, { collectSec: NaN }, { collectSec: 0 }, { cueSec: 11 }]) {
      expect(() => validateFocusConfig({ ...DEFAULT_FOCUS_CONFIG, ...config })).toThrow()
    }
  })
  it('keeps half-open sample intervals and rejects partial, interrupted or preview labels', () => {
    expect(focusInterval(1000, 2000, 250, 4, null, false)).toMatchObject({ valid: true, sampleStart: 1000, sampleEnd: 2000, sampleEndExclusive: true })
    expect(focusInterval(1000, 2000, 250, 4, 'operator_marked_invalid', false).valid).toBe(false)
    expect(focusInterval(1000, 2000, 250, 4, null, true).valid).toBe(false)
    for (const [start, end] of [[null, 2000], [1000, 1500], [1000, 900], [1000, 3000], [NaN, 2000]]) {
      expect(focusInterval(start!, end!, 250, 4, null, false).valid).toBe(false)
    }
  })
})

describe('focus feedback channel subset', () => {
  const names = Array.from({ length: 32 }, (_, i) => `CH${i + 1}`)
  it('resolves CH-prefixed names and bare numbers to channel indices', () => {
    const { mask, matched, missing } = resolveFocusChannels('CH1 9 16 7 8 10', names)
    expect(matched).toEqual([0, 6, 7, 8, 9, 15])
    expect(missing).toEqual([])
    expect(mask).toHaveLength(32)
    expect(mask?.filter(Boolean)).toHaveLength(6)
  })
  it('prefers name matches, falls back to 1-based indices, and reports unmatched tokens', () => {
    const named = resolveFocusChannels('Fz Cz', ['Fz', 'Cz', 'Pz'])
    expect(named.matched).toEqual([0, 1])
    const byIndex = resolveFocusChannels('2', ['Fz', 'Cz', 'Pz'])
    expect(byIndex.matched).toEqual([1])
    const { mask, matched, missing } = resolveFocusChannels('CH1 bad CH99', names)
    expect(matched).toEqual([0])
    expect(missing).toEqual(['bad', 'CH99'])
    expect(mask?.filter(Boolean)).toHaveLength(1)
  })
  it('returns a null mask for empty input or when nothing matches', () => {
    expect(resolveFocusChannels('  ', names).mask).toBeNull()
    const none = resolveFocusChannels('foo bar', names)
    expect(none.mask).toBeNull()
    expect(none.missing).toEqual(['foo', 'bar'])
  })
})
