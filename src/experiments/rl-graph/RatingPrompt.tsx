import { useEffect, useState } from 'react'
import { RATING_LABELS } from '../../lib/signal/manual'

export function RatingPrompt({
  open,
  timeoutMs,
  infinite,
  onRate,
  onTimeout,
}: {
  open: boolean
  timeoutMs: number
  infinite: boolean
  onRate: (value: number) => void
  onTimeout: () => void
}) {
  const [left, setLeft] = useState(timeoutMs)

  useEffect(() => {
    if (!open) return
    setLeft(timeoutMs)
    if (infinite) return

    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const remain = Math.max(0, timeoutMs - (now - start))
      setLeft(remain)
      if (remain <= 0) {
        onTimeout()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, timeoutMs, infinite, onTimeout])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const hit = RATING_LABELS.find((r) => r.key === e.key)
      if (hit) {
        e.preventDefault()
        onRate(hit.value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onRate])

  if (!open) return null

  const pct = infinite ? 100 : (left / timeoutMs) * 100

  return (
    <div className="panel absolute inset-x-4 bottom-4 z-10 p-4 shadow-2xl sm:inset-x-auto sm:right-4 sm:w-[360px]">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold">这一步动作如何？</h3>
        <span className="chip font-mono">
          {infinite ? '等待评分' : `${(left / 1000).toFixed(1)}s`}
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[#0f1526]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-75"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {RATING_LABELS.map((r) => (
          <button
            key={r.key}
            type="button"
            className="btn flex-col px-1 py-2 text-xs"
            onClick={() => onRate(r.value)}
          >
            <span className="font-mono text-sm">{r.key}</span>
            <span className="muted">{r.label}</span>
          </button>
        ))}
      </div>
      <p className="muted mt-2 text-xs">按键 1–5 或点击按钮。超时记 0。</p>
    </div>
  )
}
