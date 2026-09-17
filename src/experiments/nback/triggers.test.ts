import { expect, it } from 'vitest'
import { nbackTriggerCode, nbackTriggerLabel } from './triggers'
import { scoreTrial } from './engine'

const block = '12345678-1234-1234-1234-123456789012'
it('separates every ERP condition and result while preserving old onset codes', () => {
  for (const n of [1, 2, 3]) {
    const warmup = { letter: 'A', target: false, scored: false }
    const target = { letter: 'R', target: true, scored: true }
    const nontarget = { letter: 'C', target: false, scored: true }
    expect([warmup, nontarget, target].map(t => nbackTriggerCode('stimulus_onset', t, n))).toEqual([110+n, 120+n, 130+n])
    expect([warmup, nontarget, target].map(t => nbackTriggerCode('stimulus_offset', t, n))).toEqual([140+n, 150+n, 160+n])
    expect([warmup, target, nontarget].map(t => nbackTriggerCode('response', scoreTrial(t, 0, 450), n))).toEqual([201, 202, 203])
    const results = [scoreTrial(warmup, 0, null), scoreTrial(target, 1, 450), scoreTrial(target, 2, null),
      scoreTrial(nontarget, 3, 450), scoreTrial(nontarget, 4, null)]
    expect(results.map(r => nbackTriggerCode('trial_end', r, n))).toEqual([400, 401, 402, 403, 404])
    for (const result of results) {
      const label = nbackTriggerLabel('trial_end', result, n, block)
      expect(label).toContain(`b=${block}:n=${n}:t=${result.index}`)
      expect(label).toContain(`c=${result.outcome}`)
      expect(label.length).toBeLessThanOrEqual(128)
    }
  }
})

it('keeps all configured labels within GUI limits with no control characters', () => {
  const result = { index: 102, letter: 'R', target: false, scored: true, outcome: 'correct_rejection', rtMs: 2999.99 }
  for (const type of ['block_start', 'stimulus_onset', 'stimulus_offset', 'response', 'trial_end', 'block_end', 'block_abort']) {
    const label = nbackTriggerLabel(type, result, 3, block)
    expect(label.length).toBeLessThanOrEqual(128)
    expect(label).not.toMatch(/[\x00-\x1f]/)
  }
  expect(nbackTriggerCode('trigger_ack', {}, 2)).toBeNull()
  expect(nbackTriggerCode('trial_end', { outcome: 'invalid' }, 2)).toBeNull()
})
