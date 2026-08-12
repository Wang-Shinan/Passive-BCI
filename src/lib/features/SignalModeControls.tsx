import {
  CONTROL_SIGNAL_OPTIONS,
  CONTROL_SIGNAL_TIER_LABEL,
  CONTROL_SIGNAL_TIER_ORDER,
  type AffectChannel,
  type ControlSignalTier,
  type SignalControlMode,
} from './controlMapping'

/** Compact mode switch + optional stress-driver picker for experiment sidebars. */
export function SignalModeControls({
  mode,
  onModeChange,
  driverFeature,
  onDriverChange,
  affectDrivers,
  className,
}: {
  mode: SignalControlMode
  onModeChange: (m: SignalControlMode) => void
  /** Stress games: which feature drives 0–100 stress. */
  driverFeature?: string
  onDriverChange?: (id: string) => void
  /** Draw-guess: show mapping table. */
  affectDrivers?: Record<AffectChannel, string>
  className?: string
}) {
  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          className={`btn flex-1 text-xs ${mode === 'manual' ? 'btn-primary' : ''}`}
          onClick={() => onModeChange('manual')}
        >
          手动输入
        </button>
        <button
          type="button"
          className={`btn flex-1 text-xs ${mode === 'features' ? 'btn-primary' : ''}`}
          onClick={() => onModeChange('features')}
        >
          演示数据
        </button>
      </div>
      <p className="muted mb-2 text-xs leading-relaxed">
        {mode === 'manual'
          ? '滑块 / 快捷键直接控制游戏；合成 EEG 仅作特征预览。'
          : '演示 EEG → 可选 C 档及以上特征驱动难度（默认 rms）。点「手动输入」接管。'}
      </p>
      {driverFeature !== undefined && onDriverChange ? (
        <label className="mb-0 block text-xs">
          <span className="muted">难度 / 信息驱动信号</span>
          <select
            className="mt-1 w-full rounded-lg border border-[#2a3550] bg-[#0d1425] px-2 py-1.5 text-sm"
            value={driverFeature}
            onChange={(e) => onDriverChange(e.target.value)}
            disabled={mode !== 'features'}
          >
            {CONTROL_SIGNAL_TIER_ORDER.map((tier) => {
              const opts = CONTROL_SIGNAL_OPTIONS.filter((o) => o.tier === tier)
              if (!opts.length) return null
              return (
                <optgroup key={tier} label={CONTROL_SIGNAL_TIER_LABEL[tier as ControlSignalTier]}>
                  {opts.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                      {o.note ? ` — ${o.note}` : ''}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
        </label>
      ) : null}
      {affectDrivers ? (
        <ul className="muted mb-0 mt-2 space-y-0.5 pl-4 text-xs">
          <li>满意度 ← {affectDrivers.satisfaction}</li>
          <li>惊讶度 ← {affectDrivers.surprise}</li>
          <li>专注度 ← {affectDrivers.focus}</li>
          <li>活跃度 ← {affectDrivers.arousal}</li>
        </ul>
      ) : null}
    </div>
  )
}
