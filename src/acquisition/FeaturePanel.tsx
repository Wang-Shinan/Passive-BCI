import { FeatureMonitorPanel } from '../lib/features/FeatureMonitorPanel'
import type { LiveFeatureSnapshot } from '../lib/features/bandFeatures'

/** Acquisition-page wrapper around the shared feature monitor. */
export function FeaturePanel({
  latest,
  history,
  analyzing,
  enabledIds,
  onEnabledChange,
}: {
  latest: LiveFeatureSnapshot | null
  history: LiveFeatureSnapshot[]
  analyzing: boolean
  enabledIds: string[]
  onEnabledChange: (ids: string[]) => void
}) {
  return (
    <FeatureMonitorPanel
      latest={latest}
      history={history}
      analyzing={analyzing}
      enabledIds={enabledIds}
      onEnabledChange={onEnabledChange}
      compact={false}
      defaultPickerOpen
      note="基于滤波环缓冲滑窗 FFT。勾选与实验页共用。"
    />
  )
}
