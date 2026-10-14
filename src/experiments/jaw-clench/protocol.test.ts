import { describe, expect, it } from 'vitest'
import { createJawPlan, DEFAULT_JAW_CONFIG, jawInterval, validateJawConfig } from './protocol'

describe('cued jaw-clench acquisition', () => {
  it('balances the full session and short blocks reproducibly', () => {
    const config = { ...DEFAULT_JAW_CONFIG, trials: 22 }
    const plan = createJawPlan(config, 42)
    expect(plan).toEqual(createJawPlan(config, 42))
    expect(plan).not.toEqual(createJawPlan(config, 43))
    expect(plan.filter(label => label === 'clench')).toHaveLength(11)
    for (let i = 0; i < plan.length; i += 4) {
      const block = plan.slice(i, i + 4)
      expect(block.filter(label => label === 'clench')).toHaveLength(block.length / 2)
    }
  })
  it('rejects plans that cannot provide balanced, bounded trials', () => {
    for (const config of [{ trials: 3 }, { trials: 0 }, { collectSec: NaN }, { collectSec: 0 }, { cueSec: 11 }]) {
      expect(() => validateJawConfig({ ...DEFAULT_JAW_CONFIG, ...config })).toThrow()
    }
  })
  it('keeps half-open sample intervals and rejects partial, interrupted or preview labels', () => {
    expect(jawInterval(1000, 1500, 250, 2, null, false)).toMatchObject({ valid: true, sampleStart: 1000, sampleEnd: 1500, sampleEndExclusive: true })
    expect(jawInterval(1000, 1500, 250, 2, 'operator_marked_invalid', false).valid).toBe(false)
    expect(jawInterval(1000, 1500, 250, 2, null, true).valid).toBe(false)
    for (const [start, end] of [[null, 1500], [1000, 1100], [1000, 900], [1000, 2000], [NaN, 1500]]) {
      expect(jawInterval(start!, end!, 250, 2, null, false).valid).toBe(false)
    }
  })
})
