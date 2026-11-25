import { FeatureMonitorPanel } from '../lib/features/FeatureMonitorPanel'
import type { LiveFeatureSnapshot } from '../lib/features/bandFeatures'

/** Acquisition-page wrapper around the shared feature monitor. */
export function FeaturePanel({
  latest,
  history,
  analyzing,
  enabledIds,
  onEnabledChange,
  channelNames,
  channelTypes,
}: {
  latest: LiveFeatureSnapshot | null
  history: LiveFeatureSnapshot[]
  analyzing: boolean
  enabledIds: string[]
  onEnabledChange: (ids: string[]) => void
  channelNames: string[]
  channelTypes: string[]
}) {
  return (
    <FeatureMonitorPanel
      latest={latest}
      history={history}
      analyzing={analyzing}
      enabledIds={enabledIds}
      onEnabledChange={onEnabledChange}
      channelNames={channelNames}
      channelTypes={channelTypes}
      compact={false}
      defaultPickerOpen
      note="特征从原始 EEG 滑窗计算。"
    />
  )
}
