import { BCIGO_CHANNEL_NAMES } from '../../acquisition/bcigo/client'
import { NEURACLE_59_EEG_CHANNEL_NAMES } from '../../acquisition/neuracle/client'
import type { RawBridgeBatch } from '../../acquisition/runtime'

export type ModelSourceProfile = {
  id: string
  device: RawBridgeBatch['device']
  channelNames: readonly string[]
  label: string
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
]

function sameChannelNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
  )
}

export function matchModelSourceProfile(
  batch: RawBridgeBatch,
): ModelSourceProfile | null {
  return (
    MODEL_SOURCE_PROFILES.find(
      (profile) =>
        profile.device === batch.device &&
        batch.channels === profile.channelNames.length &&
        sameChannelNames(batch.channelNames, profile.channelNames),
    ) ?? null
  )
}

export function describeWaitingModelSource(): string {
  return MODEL_SOURCE_PROFILES.map((profile) => profile.label).join(' / ')
}

export function describeModelSource(profile: ModelSourceProfile, batch: RawBridgeBatch): string {
  return `${profile.label} · ${batch.sampleRate} Hz · 原始 uV`
}
