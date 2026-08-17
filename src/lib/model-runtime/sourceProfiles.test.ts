import { describe, expect, it } from 'vitest'
import { BCIGO_CHANNEL_NAMES } from '../../acquisition/bcigo/client'
import { NEURACLE_59_EEG_CHANNEL_NAMES } from '../../acquisition/neuracle/client'
import {
  describeWaitingModelSource,
  matchModelSourceProfile,
} from './sourceProfiles'

describe('model source profiles', () => {
  it('matches Neuracle 59 and BCIGo 32 layouts', () => {
    expect(
      matchModelSourceProfile({
        values: new Float32Array(59),
        samples: 1,
        channels: 59,
        sampleRate: 1000,
        channelNames: [...NEURACLE_59_EEG_CHANNEL_NAMES],
        unit: 'uV',
        packetLoss: 0,
        packetCount: 1,
        device: 'neuracle',
        streamId: 1,
      })?.id,
    ).toBe('neuracle59')

    expect(
      matchModelSourceProfile({
        values: new Float32Array(32),
        samples: 1,
        channels: 32,
        sampleRate: 250,
        channelNames: [...BCIGO_CHANNEL_NAMES],
        unit: 'uV',
        packetLoss: 0,
        packetCount: 1,
        device: 'bcigo',
        streamId: 2,
      })?.id,
    ).toBe('bcigo32')
  })

  it('rejects unknown channel layouts', () => {
    expect(
      matchModelSourceProfile({
        values: new Float32Array(32),
        samples: 1,
        channels: 32,
        sampleRate: 250,
        channelNames: ['C3', 'C4'],
        unit: 'uV',
        packetLoss: 0,
        packetCount: 1,
        device: 'bcigo',
        streamId: 1,
      }),
    ).toBeNull()
  })

  it('describes supported waiting sources', () => {
    expect(describeWaitingModelSource()).toContain('BCIGo 32 导')
    expect(describeWaitingModelSource()).toContain('Neuracle 59 导')
  })
})
