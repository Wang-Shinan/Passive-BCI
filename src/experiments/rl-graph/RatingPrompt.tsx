import { useEffect, useState } from 'react'
import { RATING_LABELS } from '../../lib/signal/manual'

export function RatingPrompt({
  open,
  timeoutMs,
  infinite,
  onRate,
  onTimeout,
  enableText = false,
  busy = false,
  busyLabel = 'AI 正在分配 Q…',
}: {
  open: boolean
  timeoutMs: number
  infinite: boolean
  onRate: (value: number, text?: string) => void
  onTimeout: () => void
  enableText?: boolean
  busy?: boolean
  busyLabel?: string
}) {
  const [left, setLeft] = useState(timeoutMs)
  const [text, setText] = useState('')

  useEffect(() => {
    if (!open) {
      setText('')
      return
    }
    setLeft(timeoutMs)
    if (infinite || busy) return

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
  }, [open, timeoutMs, infinite, onTimeout, busy])

  useEffect(() => {
    if (!open || busy) return
    const onKey = (e: KeyboardEvent) => {
      if (enableText && (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
        return
      }
      const hit = RATING_LABELS.find((r) => r.key === e.key)
      if (hit) {
        e.preventDefault()
        onRate(hit.value, text)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onRate, enableText, text, busy])

  if (!open) return null

  const pct = infinite || busy ? 100 : (left / timeoutMs) * 100

  return (
    <div className="panel absolute inset-x-4 bottom-4 z-10 p-4 shadow-2xl sm:inset-x-auto sm:right-4 sm:w-[380px]">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold">这一步动作如何？</h3>
        <span className="chip font-mono">
          {busy ? 'AI…' : infinite ? '等待评分' : `${(left / 1000).toFixed(1)}s`}
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[#0f1526]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-75"
          style={{ width: `${pct}%` }}
        />
      </div>

      {busy ? (
        <p className="m-0 text-sm text-[var(--accent)]">{busyLabel}</p>
      ) : (
        <>
          {enableText && (
            <label className="mb-3 block text-xs">
              <span className="muted mb-1 block">文字反馈（可选，会交给 AI）</span>
              <textarea
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[#0f1526] px-2 py-1.5 text-sm text-white outline-none focus:border-[var(--accent)]"
                rows={2}
                value={text}
                placeholder="例如：偏近了 / 方向不对 / 绕远了…"
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          )}
          <div className="grid grid-cols-5 gap-1.5">
            {RATING_LABELS.map((r) => (
              <button
                key={r.key}
                type="button"
                className="btn flex-col px-1 py-2 text-xs"
                onClick={() => onRate(r.value, text)}
              >
                <span className="font-mono text-sm">{r.key}</span>
                <span className="muted">{r.label}</span>
              </button>
            ))}
          </div>
          <p className="muted mt-2 text-xs">
            按键 1–5 或点击按钮。超时不更新价值表。
            {enableText ? ' AI 可见局部 Q 候选与反馈，不可见完整图。' : ''}
          </p>
        </>
      )}
    </div>
  )
}
