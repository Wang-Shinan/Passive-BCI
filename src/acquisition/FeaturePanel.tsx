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
      note="滑窗 FFT 走原始环（未做 5–50 Hz 显示滤波），否则 θ/δ 被滤掉、focus_score 几乎不变。勾选与实验页共用。"
    />
  )
}
