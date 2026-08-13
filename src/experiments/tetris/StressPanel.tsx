import { useEffect } from 'react'
import { Slider } from '../../lib/ui/Slider'
import { Panel } from '../../lib/ui/Panel'
import type { ReactNode } from 'react'
import type { SignalControlMode } from '../../lib/features'

/** Keys 1–5 → stress 0 / 25 / 50 / 75 / 100 */
export const STRESS_KEY_LEVELS: Record<string, number> = {
  '1': 0,
  '2': 25,
  '3': 50,
  '4': 75,
  '5': 100,
}

export function StressPanel({
  stress,
  onChange,
  compact = false,
  mode = 'manual',
  modeControls,
}: {
  stress: number
  /** User gesture handler (takes manual control). */
  onChange: (v: number) => void
  compact?: boolean
  mode?: SignalControlMode
  modeControls?: ReactNode
}) {
  const featureDriven = mode !== 'manual'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // In demo/feature mode, ignore keys so we don't instantly leave the mode.
      if (featureDriven) return
      if (e.key in STRESS_KEY_LEVELS) {
        e.preventDefault()
        onChange(STRESS_KEY_LEVELS[e.key]!)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onChange(Math.min(100, stress + (e.shiftKey ? 5 : 1)))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        onChange(Math.max(0, stress - (e.shiftKey ? 5 : 1)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stress, onChange, featureDriven])

  return (
    <Panel
      title="压力输入"
      actions={
        <span className="chip" style={{ color: featureDriven ? 'var(--accent-2)' : 'var(--muted)' }}>
          {mode === 'live' ? '实时 EEG' : featureDriven ? '演示/特征' : '手动'}
        </span>
      }
    >
      {modeControls ? <div className="mb-3">{modeControls}</div> : null}
      <Slider
        label={
          mode === 'live'
            ? '压力 0–100（实时 EEG 输出，只读）'
            : featureDriven
              ? '压力 0–100（演示数据输出，只读）'
              : '压力 0–100'
        }
        value={Math.round(stress)}
        min={0}
        max={100}
        step={1}
        onChange={onChange}
        disabled={featureDriven}
      />
      <div className="mt-3 flex gap-1.5">
        {([1, 2, 3, 4, 5] as const).map((k) => {
          const value = STRESS_KEY_LEVELS[String(k)]!
          const active = Math.abs(stress - value) < 0.5
          return (
            <button
              key={k}
              type="button"
              className={`btn flex-1 px-1 py-2 text-xs ${active ? 'btn-primary' : ''}`}
              disabled={featureDriven}
              onClick={() => onChange(value)}
            >
              <span className="font-mono text-sm">{k}</span>
              <span className="muted mt-0.5 block">{value}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-3 h-3 overflow-hidden rounded-full bg-[#0f1526]">
        <div
          className="h-full rounded-full transition-[width] duration-100"
          style={{
            width: `${stress}%`,
            background:
              stress < 35 ? '#38d39f' : stress < 65 ? '#f5a524' : '#ff5d6c',
          }}
        />
      </div>
      <p className="muted mt-2 text-xs">
        {mode === 'live'
          ? '实时 EEG 正在调控；点「手动输入」可接管。快捷键与滑块在此模式下禁用。'
          : featureDriven
            ? '演示数据正在调控；点「手动输入」可接管。快捷键与滑块在此模式下禁用。'
            : '按键 1–5 切档（0/25/50/75/100）；↑/↓ 微调，Shift+方向键 ±5。'}
      </p>
      {!compact && (
        <button
          type="button"
          className="btn mt-3 w-full"
          onClick={() => {
            window.open(
              `${window.location.origin}${window.location.pathname}#/stress-remote`,
              'stress-remote',
              'width=420,height=320',
            )
          }}
        >
          打开独立压力窗口
        </button>
      )}
    </Panel>
  )
}
