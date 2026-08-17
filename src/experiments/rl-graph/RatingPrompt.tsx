import { useEffect, useRef, useState } from 'react'
import { RATING_LABELS } from '../../lib/signal/manual'
import { LINEAR_HEAD_CLASSES, type LinearHeadPred } from './linearHead'

export function RatingPrompt({
  open,
  timeoutMs,
  infinite,
  onRate,
  onTimeout,
  enableText = false,
  busy = false,
  busyLabel = 'AI 正在分配 Q…',
  eegMode = false,
  eegTitle,
  eegHint,
  headReady = false,
  headNTrain = 0,
  headMinTrain = 5,
  headPred = null,
  skipWaitAfterRate = true,
}: {
  open: boolean
  timeoutMs: number
  infinite: boolean
  onRate: (value: number, text?: string) => void
  onTimeout: () => void
  enableText?: boolean
  busy?: boolean
  busyLabel?: string
  eegMode?: boolean
  eegTitle?: string
  eegHint?: string
  headReady?: boolean
  headNTrain?: number
  headMinTrain?: number
  headPred?: LinearHeadPred | null
  /** When true (default), 1–5 commits immediately and skips the rest of the window. */
  skipWaitAfterRate?: boolean
}) {
  const [left, setLeft] = useState(timeoutMs)
  const [text, setText] = useState('')
  const [held, setHeld] = useState<number | null>(null)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout
  const onRateRef = useRef(onRate)
  onRateRef.current = onRate
  const textRef = useRef(text)
  textRef.current = text
  const heldRef = useRef<number | null>(null)
  heldRef.current = held
  const skipWaitRef = useRef(skipWaitAfterRate)
  skipWaitRef.current = skipWaitAfterRate

  const commit = (value: number, feedback?: string) => {
    if (skipWaitRef.current || infinite) {
      onRateRef.current(value, feedback)
      return
    }
    setHeld(value)
  }

  useEffect(() => {
    if (!open) {
      setText('')
      setHeld(null)
      return
    }
    setLeft(timeoutMs)
    setHeld(null)
    if (infinite || busy) return

    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const remain = Math.max(0, timeoutMs - (now - start))
      setLeft(remain)
      if (remain <= 0) {
        const v = heldRef.current
        if (v !== null) onRateRef.current(v, textRef.current)
        else onTimeoutRef.current()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, timeoutMs, infinite, busy])

  useEffect(() => {
    if (!open || busy) return
    const onKey = (e: KeyboardEvent) => {
      if (enableText && (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
        return
      }
      const hit = RATING_LABELS.find((r) => r.key === e.key)
      if (hit) {
        e.preventDefault()
        commit(hit.value, textRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, enableText, busy, infinite])

  if (!open) return null

  const pct = infinite || busy ? 100 : timeoutMs > 0 ? (left / timeoutMs) * 100 : 0

  return (
    <div className="panel absolute inset-x-4 bottom-4 z-10 p-4 shadow-2xl sm:inset-x-auto sm:right-4 sm:w-[380px]">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold">
          {eegMode ? (eegTitle ?? '人脑评分（线性 3 类）') : '这一步动作如何？'}
        </h3>
        <span className="chip font-mono">
          {busy ? 'AI…' : infinite ? '等待评分' : `${(left / 1000).toFixed(1)}s`}
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[#0f1526]">
        <div
          className="h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${pct}%` }}
        />
      </div>

      {busy ? (
        <p className="m-0 text-sm text-[var(--accent)]">{busyLabel}</p>
      ) : (
        <>
          {eegMode ? (
            <div className="mb-3 rounded-md border border-[var(--border)] bg-[#0f1526] px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="muted text-xs">当前预测 · n={headNTrain}</span>
                <span className="font-mono text-sm">
                  {headPred
                    ? `${headPred.label} → ${headPred.rating >= 0 ? '+' : ''}${headPred.rating}`
                    : '等待特征'}
                </span>
              </div>
              {headPred ? (
                <div className="mt-1 grid grid-cols-3 gap-1 text-center font-mono text-xs">
                  {LINEAR_HEAD_CLASSES.map((label, i) => (
                    <span key={label} className={i === headPred.classIndex ? 'text-white' : 'muted'}>
                      {label} {(headPred.probs[i]! * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="muted mt-1 mb-0 text-xs">
                {eegHint ??
                  (headReady
                    ? infinite
                      ? '超时关闭：按 1–5 训练；不会自动写入预测。'
                      : '倒计时结束写入头预测；按 1–5 则训练并覆盖。'
                    : `还需 ${Math.max(0, headMinTrain - headNTrain)} 次按键后超时才用头。`)}
              </p>
            </div>
          ) : null}
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
                className={`btn flex-col px-1 py-2 text-xs ${held === r.value ? 'btn-primary' : ''}`}
                onClick={() => commit(r.value, text)}
              >
                <span className="font-mono text-sm">{r.key}</span>
                <span className="muted">{r.label}</span>
              </button>
            ))}
          </div>
          <p className="muted mt-2 text-xs">
            {!skipWaitAfterRate && !infinite
              ? held != null
                ? '已记下评分，倒计时结束才提交并进入下一步；可再按键改选。'
                : '按键只记下评分，倒计时走完才提交（固定窗口，不立刻跳过）。'
              : eegMode
                ? eegTitle
                  ? infinite
                    ? '按 1–5 提交反馈；超时关闭，不自动写入。'
                    : headReady
                      ? '按键提交反馈；超时使用已声明的任务头输出。'
                      : '任务头语义不兼容，超时不会更新价值表。'
                  : infinite
                    ? '按 1–5 训练线性头。超时关闭，不自动写入。'
                    : headReady
                      ? '按键 1–5 训练头；超时写入 差/中/好。'
                      : '先按 1–5 积累样本；样本不足时超时不更新价值表。'
                : '按键 1–5 或点击按钮。超时不更新价值表。'}
            {enableText ? ' AI 可见局部 Q 候选与反馈，不可见完整图。' : ''}
          </p>
        </>
      )}
    </div>
  )
}
