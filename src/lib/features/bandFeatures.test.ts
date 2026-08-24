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
    expect(isNonScalpEegChannel('HEOR')).toBe(true)
    expect(isNonScalpEegChannel('VEOL')).toBe(true)
    expect(isNonScalpEegChannel('Trigger')).toBe(true)
    expect(isNonScalpEegChannel('ECG')).toBe(true)
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

  it('caps dense 1000 Hz montages to a handful of channels', () => {
    const n = 32
    const fs = 1000
    const cap = fs
    const buffers = Array.from({ length: n }, () => new Float32Array(cap))
    const names = Array.from({ length: n }, (_, i) => `Ch${i + 1}`)
    names[2] = 'C3'
    names[3] = 'Cz'
    names[4] = 'C4'
    names[5] = 'F3'
    names[6] = 'F4'
    names[7] = 'P3'
    names[8] = 'P4'
    names[9] = 'Pz'
    for (let c = 0; c < n; c++) {
      for (let i = 0; i < cap; i++) buffers[c]![i] = c + 1
    }
    const snap = computeLiveFeatures({
      buffers,
      writeHead: 0,
      filled: cap,
      sampleRate: fs,
      channelNames: names,
      enabledFeatures: ['mean', 'rms', 'std', 'pow_freq_bands'],
    })
    expect(snap).not.toBeNull()
    expect(snap!.nChannels).toBeLessThanOrEqual(8)
  })
})
