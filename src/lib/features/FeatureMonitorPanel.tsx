import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import type { LiveFeatureSnapshot } from './bandFeatures'
import type { FeatureOrigin } from './useFeatureMonitor'
import {
  FEATURE_CATALOG,
  FEATURE_GROUPS,
  displayKeysForEnabled,
  formatFeatureValue,
  labelForDisplayKey,
  softScore,
  type FeatureDef,
} from './featureCatalog'

const SPARK_COLORS = [
  '#5b8cff',
  '#22d3ee',
  '#38d39f',
  '#f5a524',
  '#ff5d6c',
  '#c084fc',
  '#94a3b8',
  '#fb7185',
]

function Sparkline({
  values,
  color,
  height = 28,
}: {
  values: number[]
  color: string
  height?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || 120
    const w = Math.max(1, Math.floor(cssW * dpr))
    const h = Math.max(1, Math.floor(height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, height)
    if (values.length < 2) return

    const finite = values.filter((v) => Number.isFinite(v))
    if (finite.length < 2) return
    const min = Math.min(...finite)
    const max = Math.max(...finite)
    const span = Math.max(1e-6, max - min)
    ctx.strokeStyle = color
    ctx.lineWidth = 1.4
    ctx.beginPath()
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) return
      const x = (i / (values.length - 1)) * (cssW - 2) + 1
      const y = height - 2 - ((v - min) / span) * (height - 4)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }, [values, color, height])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
      aria-hidden
    />
  )
}

function displayValue(key: string, raw: number): string {
  if (key.endsWith('_score') || key === 'cognitive_load' || key === 'drowsiness') {
    return softScore(raw).toFixed(1)
  }
  return formatFeatureValue(key, raw)
}

export function FeatureMonitorPanel({
  latest,
  history,
  analyzing,
  enabledIds,
  onEnabledChange,
  compact = false,
  note,
  defaultPickerOpen,
  origin,
}: {
  latest: LiveFeatureSnapshot | null
  history: LiveFeatureSnapshot[]
  analyzing: boolean
  enabledIds: string[]
  onEnabledChange: (ids: string[]) => void
  /** Collapse checkbox grid by default (for game sidebars). */
  compact?: boolean
  note?: string
  defaultPickerOpen?: boolean
  origin?: FeatureOrigin
}) {
  const [pickerOpen, setPickerOpen] = useState(
    defaultPickerOpen ?? !compact,
  )
  const enabled = useMemo(() => new Set(enabledIds), [enabledIds])
  const displayKeys = useMemo(() => displayKeysForEnabled(enabled), [enabled])

  const toggle = (id: string) => {
    const next = new Set(enabled)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onEnabledChange([...next])
  }

  const setGroup = (groupId: string, on: boolean) => {
    const next = new Set(enabled)
    for (const f of FEATURE_CATALOG) {
      if (f.group === groupId) {
        if (on) next.add(f.id)
        else next.delete(f.id)
      }
    }
    onEnabledChange([...next])
  }

  const selectAll = () => onEnabledChange(FEATURE_CATALOG.map((f) => f.id))
  const selectLight = () =>
    onEnabledChange(FEATURE_CATALOG.filter((f) => !f.heavy).map((f) => f.id))
  const clearAll = () => onEnabledChange([])

  return (
    <Panel
      title="EEG 特征监控"
      className="mb-4"
      actions={
        <span className="chip" style={{ color: analyzing ? 'var(--accent-2)' : 'var(--muted)' }}>
          {origin === 'stale'
            ? '实时已断开 · 已冻结'
            : origin === 'synth'
              ? '合成 EEG'
              : analyzing
                ? latest
                  ? `滑窗 ${latest.windowSec.toFixed(1)}s · ${displayKeys.length} 项`
                  : '分析中…'
                : '未运行'}
        </span>
      }
    >
      <p className="muted mb-3 mt-0 text-xs leading-relaxed">
        {note ??
          '与采集调试 / 离线 epoch_feature_extraction 同一套可勾选特征；勾选状态全站共用。'}
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          className="btn secondary"
          onClick={() => setPickerOpen((o) => !o)}
        >
          {pickerOpen ? '收起勾选' : `展开勾选（${enabledIds.length}）`}
        </button>
        <button type="button" className="btn secondary" onClick={selectLight}>
          轻量默认
        </button>
        <button type="button" className="btn secondary" onClick={selectAll}>
          全选
        </button>
        <button type="button" className="btn secondary" onClick={clearAll}>
          清空
        </button>
      </div>

      {pickerOpen ? (
        <div
          className={`mb-4 grid gap-3 ${
            compact ? 'grid-cols-1' : 'lg:grid-cols-2 xl:grid-cols-3'
          }`}
        >
          {FEATURE_GROUPS.map((g) => {
            const items = FEATURE_CATALOG.filter((f) => f.group === g.id)
            const onCount = items.filter((f) => enabled.has(f.id)).length
            return (
              <div
                key={g.id}
                className="rounded-lg border border-[var(--border)] bg-[#0c1220] p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="m-0 text-sm font-semibold">
                    {g.label}{' '}
                    <span className="muted font-normal">
                      {onCount}/{items.length}
                    </span>
                  </h3>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setGroup(g.id, true)}
                    >
                      全开
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setGroup(g.id, false)}
                    >
                      全关
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {items.map((f) => (
                    <label
                      key={f.id}
                      className="flex cursor-pointer items-center gap-2 text-xs leading-tight"
                    >
                      <input
                        type="checkbox"
                        checked={enabled.has(f.id)}
                        onChange={() => toggle(f.id)}
                      />
                      <span className="font-mono">{f.label}</span>
                      {f.heavy ? (
                        <span className="chip" style={{ fontSize: 10, padding: '0 6px' }}>
                          重
                        </span>
                      ) : null}
                      {f.expandsTo ? (
                        <span className="muted">×{f.expandsTo.length}</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {!latest || !displayKeys.length ? (
        <p className="muted m-0 text-sm">
          {enabledIds.length === 0
            ? '请至少勾选一项特征。'
            : '等待滑窗数据…'}
        </p>
      ) : (
        <div
          className={`grid gap-2 ${
            compact
              ? 'grid-cols-1 sm:grid-cols-2'
              : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
          }`}
        >
          {displayKeys.map((key, i) => {
            const raw = latest.values[key]
            const series = history
              .map((h) => {
                const v = h.values[key]
                if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
                if (key.endsWith('_score') || key === 'cognitive_load' || key === 'drowsiness') {
                  return softScore(v)
                }
                return v
              })
              .filter((v): v is number => typeof v === 'number')
            const color = SPARK_COLORS[i % SPARK_COLORS.length]!
            const def: FeatureDef | undefined = FEATURE_CATALOG.find(
              (f) => f.id === key || f.expandsTo?.includes(key),
            )
            return (
              <div
                key={key}
                className="rounded-lg border border-[var(--border)] bg-[#0c1220] p-2.5"
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs" style={{ color }} title={key}>
                    {labelForDisplayKey(key)}
                    {def?.heavy ? ' ·重' : ''}
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold" style={{ color }}>
                    {raw === undefined ? '—' : displayValue(key, raw)}
                  </span>
                </div>
                <Sparkline values={series} color={color} />
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
