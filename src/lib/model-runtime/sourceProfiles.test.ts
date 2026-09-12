import { describe, expect, it } from 'vitest'
import { BCIGO_CHANNEL_NAMES } from '../../acquisition/bcigo/client'
import { NEURACLE_59_EEG_CHANNEL_NAMES } from '../../acquisition/neuracle/client'
import { OMNI_CHANNEL_NAMES } from '../../acquisition/omni/client'
import {
  describeWaitingModelSource,
  matchModelSourceProfile,
  projectRawBatchToProfile,
} from './sourceProfiles'
import type { RawBridgeBatch } from '../../acquisition/runtime'

function batch(partial: Partial<RawBridgeBatch> & Pick<RawBridgeBatch, 'channelNames' | 'device' | 'channels'>): RawBridgeBatch {
  return {
    values: new Float32Array(partial.channels),
    samples: 1,
    sampleRate: 1000,
    unit: 'uV',
    packetLoss: 0,
    packetCount: 1,
    streamId: 1,
    ...partial,
  }
}

describe('model source profiles', () => {
  it('matches Neuracle 59 and BCIGo 32 layouts', () => {
    expect(
      matchModelSourceProfile(
        batch({
          channels: 59,
          sampleRate: 1000,
          channelNames: [...NEURACLE_59_EEG_CHANNEL_NAMES],
          device: 'neuracle',
        }),
      )?.profile.id,
    ).toBe('neuracle59')

    expect(
      matchModelSourceProfile(
        batch({
          channels: 32,
          sampleRate: 250,
          channelNames: [...BCIGO_CHANNEL_NAMES],
          device: 'bcigo',
        }),
      )?.profile.id,
    ).toBe('bcigo32')

    expect(
      matchModelSourceProfile(
        batch({
          channels: 8,
          sampleRate: 250,
          channelNames: [...OMNI_CHANNEL_NAMES],
          device: 'omni',
        }),
      )?.profile.id,
    ).toBe('omni8')
  })

  it('matches OmniBCI 8-ch even when montage aliases replace CH1–CH8', () => {
    expect(
      matchModelSourceProfile(
        batch({
          channels: 8,
          sampleRate: 250,
          channelNames: ['FC3', 'FCz', 'FC4', 'C3', 'Cz', 'C4', 'CP3', 'CP4'],
          device: 'omni',
        }),
      )?.profile.id,
    ).toBe('omni8')
  })

  it('drops Neuracle ECG / EOG / Trigger from a 65-ch forward', () => {
    const extras = ['ECG', 'HEOR', 'HEOL', 'VEOU', 'VEOL', 'Trigger']
    const names = [...NEURACLE_59_EEG_CHANNEL_NAMES, ...extras]
    const samples = 2
    const channels = names.length
    const values = new Float32Array(samples * channels)
    for (let s = 0; s < samples; s++) {
      for (let c = 0; c < channels; c++) {
        values[s * channels + c] = c + s * 100
      }
    }
    const matched = matchModelSourceProfile(
      batch({
        values,
        samples,
        channels,
        channelNames: names,
        device: 'neuracle',
      }),
    )
    expect(matched?.profile.id).toBe('neuracle59')
    expect(matched?.indices).toHaveLength(59)
    expect(matched?.indices[28]).toBe(28)
    const projected = projectRawBatchToProfile(
      batch({
        values,
        samples,
        channels,
        channelNames: names,
        device: 'neuracle',
      }),
      matched!,
    )
    expect(projected.channels).toBe(59)
    expect(projected.channelNames).toEqual([...NEURACLE_59_EEG_CHANNEL_NAMES])
    expect(projected.values[28]).toBe(28)
    expect(projected.values[59 + 28]).toBe(128)
    expect(projected.values.length).toBe(59 * 2)
  })

  it('rejects unknown channel layouts', () => {
    expect(
      matchModelSourceProfile(
        batch({
          channels: 32,
          sampleRate: 250,
          channelNames: ['C3', 'C4'],
          device: 'bcigo',
        }),
      ),
    ).toBeNull()
  })

  it('describes supported waiting sources', () => {
    expect(describeWaitingModelSource()).toContain('BCIGo 32 导')
    expect(describeWaitingModelSource()).toContain('Neuracle 59 导')
    expect(describeWaitingModelSource()).toContain('OmniBCI 8 导')
  })
})
