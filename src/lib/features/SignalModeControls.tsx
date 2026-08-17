import { LiveEegBadge } from '../eeg/LiveEegBadge'
import { useLiveEeg } from '../eeg/useLiveEeg'
import {
  CONTROL_SIGNAL_OPTIONS,
  CONTROL_SIGNAL_TIER_LABEL,
  CONTROL_SIGNAL_TIER_ORDER,
  type AffectChannel,
  type ControlSignalTier,
  type FeatureRangeMap,
  type SignalControlMode,
} from './controlMapping'
import { ScoreRecipeEditor } from './ScoreRecipeEditor'
import type { RecipeEval, ScoreRecipe } from './scoreRecipe'

function RangeNum({
  value,
  onChange,
  step = 1,
}: {
  value: number
  onChange: (n: number) => void
  step?: number
}) {
  return (
    <input
      type="number"
      className="w-full min-w-0 rounded-md border border-[#2a3550] bg-[#0d1425] px-1.5 py-1 font-mono text-xs"
      value={Number.isFinite(value) ? value : ''}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

/** Compact mode switch + optional stress-driver picker for experiment sidebars. */
export function SignalModeControls({
  mode,
  onModeChange,
  driverFeature,
  onDriverChange,
  rangeMap,
  onRangeMapChange,
  onRangeReset,
  onRangeCapture,
  rangePreview,
  recipe,
  onRecipeChange,
  onRecipeReset,
  recipeEval,
  showRecipeDifficulty,
  affectDrivers,
  className,
}: {
  mode: SignalControlMode
  onModeChange: (m: SignalControlMode) => void
  /** Stress games: which feature drives 0–100 stress. */
  driverFeature?: string
  onDriverChange?: (id: string) => void
  rangeMap?: FeatureRangeMap
  onRangeMapChange?: (next: FeatureRangeMap) => void
  onRangeReset?: () => void
  onRangeCapture?: () => void
  rangePreview?: { src: number; dst: number } | null
  recipe?: ScoreRecipe
  onRecipeChange?: (next: ScoreRecipe) => void
  onRecipeReset?: () => void
  recipeEval?: RecipeEval | null
  showRecipeDifficulty?: boolean
  /** Draw-guess: show mapping table. */
  affectDrivers?: Record<AffectChannel, string>
  className?: string
}) {
  const { live } = useLiveEeg()
  const patchRange = (partial: Partial<FeatureRangeMap>) => {
    if (!rangeMap || !onRangeMapChange) return
    onRangeMapChange({ ...rangeMap, ...partial })
  }
  return (
    <div className={className}>
      <LiveEegBadge className="mb-3" />
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
        <button
          type="button"
          className={`btn flex-1 text-xs ${mode === 'live' ? 'btn-primary' : ''}`}
          onClick={() => onModeChange('live')}
        >
          实时 EEG
        </button>
      </div>
      <p className="muted mb-2 text-xs leading-relaxed">
        {mode === 'manual'
          ? '滑块 / 快捷键直接控制游戏；有实时流时特征面板显示真实 EEG。'
          : mode === 'live'
            ? live
              ? '真实 EEG 特征驱动难度。无数据时保持上次输出；点「手动输入」接管。'
              : '未收到实时样本。请先在采集页连接并点「开始采集」。'
            : '演示 EEG → 可选 C 档及以上特征驱动难度（默认 rms）。点「手动输入」接管。'}
      </p>
      {recipe && onRecipeChange ? (
        <div className="mb-3">
          <ScoreRecipeEditor
            recipe={recipe}
            onChange={onRecipeChange}
            onReset={onRecipeReset}
            evalResult={recipeEval}
            showDifficulty={showRecipeDifficulty}
          />
        </div>
      ) : null}
      {driverFeature !== undefined && onDriverChange && !recipe ? (
        <label className="mb-0 block text-xs">
          <span className="muted">难度 / 信息驱动信号</span>
          <select
            className="mt-1 w-full rounded-lg border border-[#2a3550] bg-[#0d1425] px-2 py-1.5 text-sm"
            value={driverFeature}
            onChange={(e) => onDriverChange(e.target.value)}
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
      {rangeMap && onRangeMapChange && !recipe ? (
        <div className="mt-3 space-y-2">
          <div className="muted text-xs">特征 → 难度（与监控同一数值）</div>
          <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-1.5 gap-y-1.5 text-xs">
            <span className="muted">特征</span>
            <RangeNum value={rangeMap.inMin} step={0.1} onChange={(n) => patchRange({ inMin: n })} />
            <span className="muted text-center">–</span>
            <RangeNum value={rangeMap.inMax} step={0.1} onChange={(n) => patchRange({ inMax: n })} />
            <span className="muted">难度</span>
            <RangeNum value={rangeMap.outMin} step={1} onChange={(n) => patchRange({ outMin: n })} />
            <span className="muted text-center">–</span>
            <RangeNum value={rangeMap.outMax} step={1} onChange={(n) => patchRange({ outMax: n })} />
          </div>
          {rangePreview ? (
            <p className="mb-0 font-mono text-xs">
              {rangePreview.src.toFixed(1)} → {rangePreview.dst.toFixed(1)}
            </p>
          ) : null}
          <div className="flex gap-1.5">
            {onRangeCapture ? (
              <button type="button" className="btn flex-1 text-xs" onClick={onRangeCapture}>
                按最近窗口
              </button>
            ) : null}
            {onRangeReset ? (
              <button type="button" className="btn flex-1 text-xs" onClick={onRangeReset}>
                默认
              </button>
            ) : null}
          </div>
        </div>
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
