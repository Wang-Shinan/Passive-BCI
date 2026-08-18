import { describe, expect, it } from 'vitest'
import {
  computeLiveFeatures,
  isNonScalpEegChannel,
  EEG_LEAD_OFF_SENTINEL_UV,
} from './bandFeatures'
import { BCIGO_CHANNEL_NAMES, BCIGO_HARDWARE_CHANNEL_NAMES } from '../../acquisition/bcigo/client'

describe('isNonScalpEegChannel', () => {
  it('drops IO / EOG and keeps scalp EEG', () => {
    expect(isNonScalpEegChannel('IO')).toBe(true)
    expect(isNonScalpEegChannel('Fp1', 'EOG')).toBe(true)
    expect(isNonScalpEegChannel('Fp1', 'EEG')).toBe(false)
    expect(isNonScalpEegChannel('Cz')).toBe(false)
  })
})

describe('BCIGo montage', () => {
  it('display names are a permutation of hardware names', () => {
    expect(BCIGO_CHANNEL_NAMES).toHaveLength(32)
    expect(BCIGO_HARDWARE_CHANNEL_NAMES).toHaveLength(32)
    const hw = [...BCIGO_HARDWARE_CHANNEL_NAMES].map((n) => n.toUpperCase()).sort()
    const disp = [...BCIGO_CHANNEL_NAMES].map((n) => n.toUpperCase()).sort()
    expect(disp).toEqual(hw)
    expect(BCIGO_CHANNEL_NAMES[0]).toBe('Fp1')
    expect(BCIGO_CHANNEL_NAMES[31]).toBe('IO')
  })
})

describe('computeLiveFeatures', () => {
  it('ignores IO and lead-off sentinel channels', () => {
    const n = 4
    const cap = 64
    const buffers = Array.from({ length: n }, () => new Float32Array(cap))
    for (let i = 0; i < cap; i++) {
      buffers[0]![i] = 10
      buffers[1]![i] = 20
      buffers[2]![i] = EEG_LEAD_OFF_SENTINEL_UV
      buffers[3]![i] = 30
    }
    const snap = computeLiveFeatures({
      buffers,
      writeHead: 0,
      filled: cap,
      sampleRate: 250,
      channelNames: ['Fp1', 'Cz', 'O1', 'IO'],
      enabledFeatures: ['mean'],
    })
    expect(snap).not.toBeNull()
    expect(snap!.nChannels).toBe(2)
    expect(snap!.values.mean).toBeCloseTo(15, 5)
  })
})
