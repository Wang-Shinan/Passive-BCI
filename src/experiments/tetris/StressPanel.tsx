import { useEffect } from 'react'
import { Slider } from '../../lib/ui/Slider'
import { Panel } from '../../lib/ui/Panel'

export function StressPanel({
  stress,
  onChange,
  compact = false,
}: {
  stress: number
  onChange: (v: number) => void
  compact?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [stress, onChange])

  return (
    <Panel title="压力输入（主试）">
      <Slider
        label="压力 0–100"
        value={stress}
        min={0}
        max={100}
        step={1}
        onChange={onChange}
      />
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
        ↑/↓ 微调，Shift+方向键 ±5。可在独立窗口打开以免被试看到。
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
