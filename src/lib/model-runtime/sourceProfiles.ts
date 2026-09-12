import { BCIGO_CHANNEL_NAMES } from '../../acquisition/bcigo/client'
import { NEURACLE_59_EEG_CHANNEL_NAMES } from '../../acquisition/neuracle/client'
import { OMNI_CHANNEL_NAMES } from '../../acquisition/omni/client'
import type { RawBridgeBatch } from '../../acquisition/runtime'

export type ModelSourceProfile = {
  id: string
  device: RawBridgeBatch['device']
  channelNames: readonly string[]
  label: string
}

export type MatchedModelSource = {
  profile: ModelSourceProfile
  /** Source indices in `batch.values` (sample-major) for each profile channel. */
  indices: number[]
}

export const MODEL_SOURCE_PROFILES: readonly ModelSourceProfile[] = [
  {
    id: 'neuracle59',
    device: 'neuracle',
    channelNames: NEURACLE_59_EEG_CHANNEL_NAMES,
    label: 'Neuracle 59 导',
  },
  {
    id: 'bcigo32',
    device: 'bcigo',
    channelNames: BCIGO_CHANNEL_NAMES,
    label: 'BCIGo 32 导',
  },
  {
    id: 'omni8',
    device: 'omni',
    channelNames: OMNI_CHANNEL_NAMES,
    label: 'OmniBCI 8 导',
  },
]

function normalizeChannelName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase()
}

function sameChannelNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
  )
}

/** Pick profile channels by name from a wider (or reordered) layout. */
export function channelPickIndices(
  actual: readonly string[],
  expected: readonly string[],
): number[] | null {
  const lookup = new Map<string, number>()
  for (let i = 0; i < actual.length; i++) {
    const key = normalizeChannelName(actual[i] ?? '')
    if (key && !lookup.has(key)) lookup.set(key, i)
  }
  const indices: number[] = []
  for (const name of expected) {
    const idx = lookup.get(normalizeChannelName(name))
    if (idx == null) return null
    indices.push(idx)
  }
  return indices
}

export function matchModelSourceProfile(
  batch: RawBridgeBatch,
): MatchedModelSource | null {
  for (const profile of MODEL_SOURCE_PROFILES) {
    if (profile.device !== batch.device) continue
    const indices = channelPickIndices(batch.channelNames, profile.channelNames)
    if (indices) return { profile, indices }
    // V19 API still has 8 hardware columns when the UI overlays montage aliases.
    if (profile.id === 'omni8' && batch.channels === profile.channelNames.length) {
      return { profile, indices: profile.channelNames.map((_, i) => i) }
    }
  }
  return null
}

export function projectRawBatchToProfile(
  batch: RawBridgeBatch,
  match: MatchedModelSource,
): RawBridgeBatch {
  const { profile, indices } = match
  const outChannels = profile.channelNames.length
  if (
    indices.length === batch.channels &&
    indices.every((src, i) => src === i) &&
    sameChannelNames(batch.channelNames, profile.channelNames)
  ) {
    return batch
  }
  const samples = batch.samples
  const srcCh = batch.channels
  const src = batch.values
  const values = new Float32Array(samples * outChannels)
  for (let s = 0; s < samples; s++) {
    const srcBase = s * srcCh
    const dstBase = s * outChannels
    for (let c = 0; c < outChannels; c++) {
      values[dstBase + c] = src[srcBase + indices[c]!]!
    }
  }
  return {
    ...batch,
    values,
    channels: outChannels,
    channelNames: [...profile.channelNames],
  }
}

export function describeWaitingModelSource(): string {
  return MODEL_SOURCE_PROFILES.map((profile) => profile.label).join(' / ')
}

export function describeModelSource(
  profile: ModelSourceProfile,
  batch: RawBridgeBatch,
  sourceChannels = batch.channels,
): string {
  const dropped = sourceChannels - profile.channelNames.length
  const prefix =
    dropped > 0
      ? `${profile.label} · 已从 ${sourceChannels} 导去掉 ${dropped} 路非头皮`
      : profile.label
  return `${prefix} · ${batch.sampleRate} Hz · 原始 uV`
}
