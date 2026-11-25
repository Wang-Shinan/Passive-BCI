import { describe, expect, it } from 'vitest'
import { BCIGO_CHANNEL_NAMES } from '../../acquisition/bcigo/client'
import { NEURACLE_59_EEG_CHANNEL_NAMES } from '../../acquisition/neuracle/client'
import { OMNI_CHANNEL_NAMES } from '../../acquisition/omni/client'
import { OMNI_FLEX_VER2_ELECTRODES } from '../../acquisition/omni/flexVer2'
import {
  describeWaitingModelSource,
  matchModelSourceProfile,
  projectRawBatchToProfile,
} from './sourceProfiles'
import type { RawBridgeBatch } from '../../acquisition/runtime'
import { ModelWindowAssembler } from './windowAssembler'

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
  it('builds a REVE window in Flex Ver2 order from a named Omni stream with extra channels', () => {
    const order = OMNI_FLEX_VER2_ELECTRODES.map(({ name }) => name)
    const channelNames = [...order].reverse().map(name => name.toLowerCase()).concat('E201', 'E93')
    const channels = channelNames.length
    const values = Float32Array.from({ length: channels * 2 }, (_, i) => i)
    const source = batch({
      device: 'omni', channelNames, channels, values, sampleRate: 2, samples: 2, omniFlexVer2Mapping: [],
    })
    const matched = matchModelSourceProfile(source)!
    const projected = projectRawBatchToProfile(source, matched)
    expect(projected.channelNames).toEqual(order)
    expect(projected.channels).toBe(16)
    expect(Array.from(projected.values)).toEqual([
      ...order.map((_, index) => 15 - index),
      ...order.map((_, index) => channels + 15 - index),
    ])
    expect(source.values).toHaveLength(36)
    const [packet] = new ModelWindowAssembler({ windowSec: 1 }).push(projected)
    expect(packet?.header.channel_names).toEqual(order)
    expect(packet?.header.electrode_positions).toEqual(OMNI_FLEX_VER2_ELECTRODES.map(({ position }) => position))
    expect(packet?.header.electrode_names).toBeUndefined()
  })

  it('resolves manual wiring by channel name and rejects missing or duplicated wires', () => {
    const channelNames = Array.from({ length: 32 }, (_, i) => `CH${i + 1}`)
    const mapping = channelNames.filter((_, i) => i % 2 === 1)
    const source = batch({ device: 'omni', channels: 32, channelNames, omniFlexVer2Mapping: mapping })
    expect(matchModelSourceProfile(source)?.indices).toEqual(mapping.map(name => channelNames.indexOf(name)))
    expect(matchModelSourceProfile(source, false)?.profile.id).toBe('omni32')
    expect(matchModelSourceProfile({ ...source, omniFlexVer2Mapping: ['CH33', ...mapping.slice(1)] })).toBeNull()
    expect(matchModelSourceProfile({ ...source, omniFlexVer2Mapping: ['CH4', ...mapping.slice(1)] })).toBeNull()
    expect(matchModelSourceProfile({ ...source, channelNames: ['CH2', ...channelNames.slice(1)] })).toBeNull()
    expect(matchModelSourceProfile({
      ...source, channelNames: ['E201', ...channelNames.slice(1)], omniFlexVer2Mapping: ['E201', ...mapping.slice(1)],
    })).toBeNull()
  })

  it('maps numbered Omni channels to the compacted Ver2 wiring by default', () => {
    const channelNames = Array.from({ length: 32 }, (_, i) => `CH${i + 1}`)
    const values = Float32Array.from({ length: 32 }, (_, i) => i + 1)
    const source = batch({ device: 'omni', channels: 32, channelNames, values, omniFlexVer2Mapping: [] })
    const projected = projectRawBatchToProfile(source, matchModelSourceProfile(source)!)
    expect(projected.channelNames[3]).toBe('E190')
    expect(projected.values[3]).toBe(4)
    expect(projected.channelNames[13]).toBe('E92')
    expect(projected.values[13]).toBe(14)
    expect(Array.from(projected.values)).toEqual(Array.from(values.slice(0, 16)))
  })

  it('supplies Flex Ver2 coordinates when the source is already in electrode order', () => {
    const channelNames = OMNI_FLEX_VER2_ELECTRODES.map(({ name }) => name)
    const source = batch({ device: 'omni', channels: 16, channelNames, omniFlexVer2Mapping: [] })
    const projected = projectRawBatchToProfile(source, matchModelSourceProfile(source)!)
    expect(projected.electrodePositions).toHaveLength(16)
    expect(projected.channelNames).toEqual(channelNames)
  })

  it('preserves all 32 Omni columns instead of matching the first eight', () => {
    const source = batch({ device: 'omni', channels: 32, sampleRate: 250,
      channelNames: Array.from({ length: 32 }, (_, i) => `CH${i + 1}`),
      values: Float32Array.from({ length: 32 }, (_, i) => i) })
    const matched = matchModelSourceProfile(source)!
    expect(matched.profile.id).toBe('omni32')
    const projected = projectRawBatchToProfile(source, matched)
    expect(projected.channels).toBe(32)
    expect(projected.values[31]).toBe(31)
  })
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

  it('preserves Omni electrode order and names all the way into a model window', () => {
    const names = ['FC3', 'FCz', 'FC4', 'C3', 'Cz', 'C4', 'CP3', 'CP4']
    const input = batch({ device: 'omni', channels: 8, sampleRate: 250,
      channelNames: names, samples: 500,
      values: Float32Array.from({ length: 4000 }, (_, i) => i % 8 + Math.floor(i / 8) * 10) })
    const projected = projectRawBatchToProfile(input, matchModelSourceProfile(input)!)
    const [packet] = new ModelWindowAssembler({ windowSec: 2 }).push(projected)
    expect(packet!.header.channel_names).toEqual(names)
    expect(projected.values).toBe(input.values)
    expect(projected.channelNames).toEqual(names)
  })

  it('sends independent locations without renaming labels and resets windows when locations change', () => {
    const labels = [...OMNI_CHANNEL_NAMES]
    const input = batch({ device: 'omni', channels: 8, sampleRate: 250, channelNames: labels,
      samples: 500, values: new Float32Array(4000),
      electrodeNames: ['F3', 'F4', 'C3', 'Cz', 'C4', 'P3', 'Pz', 'P4'] })
    const assembler = new ModelWindowAssembler({ windowSec: 2 })
    const [named] = assembler.push(projectRawBatchToProfile(input, matchModelSourceProfile(input)!))
    expect(named!.header.channel_names).toEqual(labels)
    expect(named!.header.electrode_names).toEqual(input.electrodeNames)
    const points = Array.from({ length: 8 }, (_, i) => [i * .01, 0, .08])
    const half = { ...input, electrodePositions: points, samples: 250, values: new Float32Array(2000) }
    expect(assembler.push(half)).toHaveLength(0)
    const [xyz] = assembler.push(half)
    expect(xyz!.header.channel_names).toEqual(labels)
    expect(xyz!.header.electrode_positions).toEqual(points)
    expect(xyz!.header.electrode_names).toBeUndefined()
    expect(xyz!.header.segment_id).not.toBe(named!.header.segment_id)
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
