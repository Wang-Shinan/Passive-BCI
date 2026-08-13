import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { FeatureMonitorPanel, useFeatureMonitor } from '../../lib/features'
import { SessionLogger } from '../../lib/logger'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import {
  clickCell,
  createSchulteTrial,
  correctRtSeries,
  rollingFocusScore,
  startTrial,
  trialSummary,
  type GridSize,
  type SchulteTrialState,
} from './engine'
import './schulte.css'

const SIZES: GridSize[] = [3, 4, 5, 6]

export function SchulteExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [size, setSize] = useState<GridSize>(5)
  const [showHint, setShowHint] = useState(false)
  const [trial, setTrial] = useState<SchulteTrialState>(() => createSchulteTrial(5))
  const [flash, setFlash] = useState<{ value: number; ok: boolean } | null>(null)
  const [liveFocus, setLiveFocus] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  const features = useFeatureMonitor({ active: true })
  const loggerRef = useRef(new SessionLogger('schulte', subjectId))
  const flashTimer = useRef<number | null>(null)

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    if (trial.status !== 'running' || trial.startedAt == null) return
    const id = window.setInterval(() => {
      setElapsedMs(performance.now() - trial.startedAt!)
    }, 50)
    return () => clearInterval(id)
  }, [trial.status, trial.startedAt])

  const summary = useMemo(() => trialSummary(trial), [trial])
  const chartData = useMemo(() => {
    const series = correctRtSeries(trial.clicks)
    return series.map((c, i) => {
      const prefix = series.slice(0, i + 1).map((s) => ({
        target: s.target,
        rtMs: s.rtMs,
        cumMs: s.cumMs,
        correct: true as const,
        tAbs: 0,
      }))
      return {
        target: c.target,
        rtMs: Math.round(c.rtMs),
        focus: rollingFocusScore(prefix, 5),
      }
    })
  }, [trial.clicks])

  const reshuffle = (n: GridSize = size) => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    setFlash(null)
    const next = createSchulteTrial(n)
    setTrial(next)
    setLiveFocus(null)
    setElapsedMs(0)
    loggerRef.current.log('reshuffle', { size: n, seed: next.seed })
  }

  const begin = () => {
    const base = trial.status === 'idle' ? trial : createSchulteTrial(size)
    const next = startTrial(base)
    setTrial(next)
    setLiveFocus(null)
    setElapsedMs(0)
    setFlash(null)
    loggerRef.current.clear()
    loggerRef.current.setSubjectId(subjectId)
    loggerRef.current.log('trial_start', { size: next.size, seed: next.seed })
  }

  const onCellClick = (value: number) => {
    if (trial.status !== 'running') return
    const { state: next, record } = clickCell(trial, value)
    if (!record) return
    setTrial(next)
    setLiveFocus(rollingFocusScore(next.clicks))

    loggerRef.current.log(record.correct ? 'click_ok' : 'click_err', {
      target: record.target,
      clicked: record.clicked ?? record.target,
      rtMs: record.rtMs,
      cumMs: record.cumMs,
      errors: next.errors,
      focus: rollingFocusScore(next.clicks),
    })

    setFlash({ value, ok: record.correct })
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 160)

    if (next.status === 'done') {
      const sum = trialSummary(next)
      loggerRef.current.log('trial_done', {
        ...sum,
        size: next.size,
        seed: next.seed,
      })
    }
  }

  const statusLabel =
    trial.status === 'idle'
      ? '准备：按「开始」后从 1 点到末格'
      : trial.status === 'running'
        ? `寻找 ${trial.nextTarget} · 已用 ${(elapsedMs / 1000).toFixed(1)} s`
        : `完成 · 总时 ${((summary.totalMs ?? 0) / 1000).toFixed(2)} s`

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-[var(--text)]">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-2 text-2xl font-semibold tracking-tight">
            实验七 · 舒尔特方格
          </h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            按顺序点击 1 → N²。每次正确点击记录反应时（相对上一正确/错误点击），曲线反映专注度波动；误点计入错误但不跳号。
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
        />
      </header>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-4">
          <Panel title="方格" actions={<span className="chip">{statusLabel}</span>}>
            <div
              className="schulte-grid"
              style={{ gridTemplateColumns: `repeat(${trial.size}, minmax(0, 1fr))` }}
            >
              {trial.cells.map((cell) => {
                const isFlash = flash?.value === cell.value
                const hint =
                  showHint &&
                  trial.status === 'running' &&
                  cell.value === trial.nextTarget
                return (
                  <button
                    key={`${cell.row}-${cell.col}-${cell.value}`}
                    type="button"
                    className={`schulte-cell${hint ? ' is-next-hint' : ''}${
                      isFlash ? (flash?.ok ? ' is-flash-ok' : ' is-flash-bad') : ''
                    }`}
                    disabled={trial.status !== 'running'}
                    onClick={() => onCellClick(cell.value)}
                  >
                    {cell.value}
                  </button>
                )
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {trial.status !== 'running' ? (
                <button type="button" className="btn btn-primary" onClick={begin}>
                  {trial.status === 'done' ? '再来一局' : '开始'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    loggerRef.current.log('trial_abort', { nextTarget: trial.nextTarget })
                    reshuffle(size)
                  }}
                >
                  中止 / 重排
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                disabled={trial.status === 'running'}
                onClick={() => reshuffle(size)}
              >
                重新洗牌
              </button>
            </div>
          </Panel>

          <Panel title="反应时轨迹（正确点击）">
            {chartData.length < 1 ? (
              <p className="muted m-0 text-sm">开始后，每点对一格会在此追加一点。</p>
            ) : (
              <div style={{ width: '100%', height: 260 }}>
                <ResponsiveContainer>
                  <LineChart data={chartData}>
                    <CartesianGrid stroke="#243049" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="target"
                      stroke="#9aa8c7"
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis yAxisId="rt" stroke="#9aa8c7" tick={{ fontSize: 11 }} />
                    <YAxis
                      yAxisId="focus"
                      orientation="right"
                      domain={[0, 100]}
                      stroke="#38d39f"
                      tick={{ fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#141b2d',
                        border: '1px solid #2a3550',
                        borderRadius: 8,
                      }}
                    />
                    <Line
                      yAxisId="rt"
                      type="monotone"
                      dataKey="rtMs"
                      name="反应时 ms"
                      stroke="#5b8cff"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                    <Line
                      yAxisId="focus"
                      type="monotone"
                      dataKey="focus"
                      name="专注指数"
                      stroke="#38d39f"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="muted mt-2 mb-0 text-xs">
              蓝线：逐步反应时（越低越快）。绿线：相对自身中位 RT 的滚动专注指数（近 5 步，0–100）。
            </p>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="设置">
            <label className="mb-3 block text-sm">
              <span className="muted mb-1 block">阶数</span>
              <select
                className="select"
                value={size}
                disabled={trial.status === 'running'}
                onChange={(e) => {
                  const n = Number(e.target.value) as GridSize
                  setSize(n)
                  reshuffle(n)
                }}
              >
                {SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}×{n}（1–{n * n}）
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showHint}
                onChange={(e) => setShowHint(e.target.checked)}
              />
              高亮下一目标（练习用）
            </label>
            <p className="muted mt-3 mb-0 text-xs">
              seed {trial.seed} · 导出含逐步 rtMs 与 focus。
            </p>
          </Panel>

          <Panel title="本局指标">
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="muted">下一目标</dt>
              <dd className="m-0 font-mono">
                {trial.status === 'done' ? '—' : trial.nextTarget}
              </dd>
              <dt className="muted">正确 / 错误</dt>
              <dd className="m-0 font-mono">
                {summary.nCorrect} / {summary.errors}
              </dd>
              <dt className="muted">总用时</dt>
              <dd className="m-0 font-mono">
                {summary.totalMs != null ? `${(summary.totalMs / 1000).toFixed(2)} s` : '—'}
              </dd>
              <dt className="muted">平均 RT</dt>
              <dd className="m-0 font-mono">
                {summary.meanRtMs != null ? `${summary.meanRtMs.toFixed(0)} ms` : '—'}
              </dd>
              <dt className="muted">中位 RT</dt>
              <dd className="m-0 font-mono">
                {summary.medianRtMs != null ? `${summary.medianRtMs.toFixed(0)} ms` : '—'}
              </dd>
              <dt className="muted">最慢一步</dt>
              <dd className="m-0 font-mono">
                {summary.maxRtMs != null ? `${summary.maxRtMs.toFixed(0)} ms` : '—'}
              </dd>
              <dt className="muted">专注指数</dt>
              <dd className="m-0">
                <span className="schulte-focus" style={{ color: 'var(--accent-2)' }}>
                  {liveFocus != null ? liveFocus.toFixed(0) : '—'}
                </span>
              </dd>
            </dl>
          </Panel>

          <LiveEegBadge />
          <FeatureMonitorPanel
            compact
            latest={features.latest}
            history={features.history}
            analyzing={features.analyzing}
            enabledIds={features.enabledIds}
            onEnabledChange={features.onEnabledChange}
            note={
              features.origin === 'live'
                ? '正在分析采集页的实时 EEG，可与逐步 RT / 专注指数对照。'
                : '合成特征流；采集页开流后会自动切到实时。可与逐步 RT 对照。'
            }
          />
        </div>
      </div>
    </div>
  )
}
