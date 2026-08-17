import { useEffect, useMemo, useRef, useState } from 'react'
import { labelForDisplayKey } from '../../lib/features/featureCatalog'
import { RATING_LABELS } from '../../lib/signal/manual'
import {
  inspectLinearFeatures,
  LINEAR_HEAD_CLASSES,
  ratingToClass,
  type LinearHeadPred,
} from './linearHead'

const HIDDEN_PRESETS = [0, 8, 16, 32] as const

type DebugHit = {
  t: number
  label: string
  pred: string
  loss: number
}

export function LinearHeadDebug({
  keys,
  values,
  pred,
  canTrain,
  hiddenSize,
  useRelu,
  lr,
  onArch,
  onLr,
  onRefit,
  archLocked = false,
  onLabel,
}: {
  keys: string[]
  values: Record<string, number> | undefined
  pred: LinearHeadPred | null
  canTrain: boolean
  hiddenSize: number
  useRelu: boolean
  lr: number
  onArch: (hiddenSize: number, useRelu: boolean) => void
  onLr: (lr: number) => void
  onRefit: () => void
  archLocked?: boolean
  onLabel: (classIndex: number) => number | null
}) {
  const [log, setLog] = useState<DebugHit[]>([])
  const onLabelRef = useRef(onLabel)
  onLabelRef.current = onLabel
  const inspect = useMemo(() => inspectLinearFeatures(values, keys), [values, keys])
  const missing = inspect.rows.filter((r) => r.unit == null).map((r) => r.id)
  const ready = inspect.vector != null

  const mark = (classIndex: number) => {
    if (!canTrain || !ready) return
    const predLabel = pred?.label ?? '—'
    const loss = onLabelRef.current(classIndex)
    if (loss == null) return
    setLog((prev) =>
      [
        {
          t: performance.now(),
          label: LINEAR_HEAD_CLASSES[classIndex] ?? '?',
          pred: predLabel,
          loss,
        },
        ...prev,
      ].slice(0, 8),
    )
  }

  useEffect(() => {
    if (!canTrain) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      const hit = RATING_LABELS.find((r) => r.key === e.key)
      if (!hit) return
      e.preventDefault()
      mark(ratingToClass(hit.value))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canTrain, ready, pred])

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <p className="mb-1 text-sm font-medium">调试（只练头）</p>
      <p className="muted mb-2 text-xs">
        不走价值表。每次按键把当前 EEG 存进全部历史，再对全量交叉熵做批量梯度下降。L 是全体样本的平均
        −log p(正确类)。
      </p>
      <div className={`mb-2 ${archLocked ? 'pointer-events-none opacity-50' : ''}`}>
        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
          <span className="muted">隐藏单元</span>
          <input
            type="number"
            className="w-16 rounded-md border border-[var(--border)] bg-[#0c1220] px-1.5 py-0.5 font-mono text-xs"
            min={0}
            max={64}
            step={1}
            value={hiddenSize}
            onChange={(e) => onArch(Number(e.target.value), useRelu)}
          />
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {HIDDEN_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={`btn px-2 py-1 text-[11px] ${hiddenSize === n ? 'btn-primary' : ''}`}
              onClick={() => onArch(n, n === 0 ? false : hiddenSize === 0 || useRelu)}
            >
              {n === 0 ? '线性' : n}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={hiddenSize > 0 && useRelu}
            disabled={hiddenSize <= 0}
            onChange={(e) => onArch(hiddenSize, e.target.checked)}
          />
          ReLU（隐藏层之后）
        </label>
        <label className="mt-2 block space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="muted">学习率</span>
            <span className="font-mono">{lr.toFixed(3)}</span>
          </div>
          <input
            type="range"
            className="w-full accent-[var(--accent)]"
            min={0.002}
            max={0.08}
            step={0.002}
            value={lr}
            onChange={(e) => onLr(Number(e.target.value))}
          />
        </label>
        <button type="button" className="btn mt-2 w-full text-[11px]" onClick={onRefit}>
          按当前学习率再拟合全量
        </button>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-1">
        {LINEAR_HEAD_CLASSES.map((label, i) => (
          <button
            key={label}
            type="button"
            className="btn py-2 text-xs"
            disabled={!canTrain || !ready}
            onClick={() => mark(i)}
          >
            {label}
            <span className="muted mt-0.5 block font-mono text-[10px]">
              {i === 0 ? '1–2' : i === 1 ? '3' : '4–5'}
            </span>
          </button>
        ))}
      </div>
      {!canTrain ? (
        <p className="muted mb-2 text-[11px]">暂停实验后再点，避免和评分窗抢键。</p>
      ) : !ready ? (
        <p className="muted mb-2 text-[11px]">
          缺特征：{missing.length ? missing.map(labelForDisplayKey).join('、') : '等待滑窗'}
        </p>
      ) : null}
      <div className="mb-2 max-h-36 space-y-0.5 overflow-y-auto">
        {inspect.rows.map((row) => (
          <div key={row.id} className="flex items-center gap-1.5 font-mono text-[10px]">
            <span className="muted w-[7.5rem] shrink-0 truncate" title={row.id}>
              {labelForDisplayKey(row.id)}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#0c1220]">
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${row.unit != null ? row.unit * 100 : 0}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right">
              {row.unit != null ? row.unit.toFixed(2) : '—'}
            </span>
          </div>
        ))}
      </div>
      {log.length ? (
        <ul className="m-0 list-none space-y-0.5 p-0 font-mono text-[10px]">
          {log.map((hit) => (
            <li key={hit.t} className="muted">
              标 {hit.label} · 当时预测 {hit.pred} · 全量CE={hit.loss.toFixed(3)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted m-0 text-[11px]">还没有调试样本。</p>
      )}
    </div>
  )
}
