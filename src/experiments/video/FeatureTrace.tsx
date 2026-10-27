import { useId, useState } from 'react'
import type { LiveFeatureSnapshot } from '../../lib/features'
import { labelForDisplayKey } from '../../lib/features/featureCatalog'

/** Inspect real feature windows without inventing a signal when acquisition is absent. */
export function FeatureTrace({ history, live }: { history: LiveFeatureSnapshot[]; live: boolean }) {
  const [selected, setSelected] = useState('focus_score')
  const [points, setPoints] = useState(60)
  const [cursor, setCursor] = useState<number | null>(null)
  const [glow, setGlow] = useState(true)
  const [preview, setPreview] = useState(false)
  const showPreview = preview && history.length === 0
  // Display-only fixture: never enters the feature hub, recorder or model controller.
  const source: LiveFeatureSnapshot[] = showPreview ? Array.from({ length: 60 }, (_, i) => ({
    t: i * 200, nChannels: 0, windowSec: 1,
    values: { focus_score: 45 + 12 * Math.sin(i / 7) + 4 * Math.sin(i / 2.1) },
  })) : history
  const uid = useId().replace(/:/g, '')
  const keys = Object.keys(source.at(-1)?.values ?? {})
  const key = keys.includes(selected) ? selected : keys[0] ?? selected
  const data = source.slice(-points)
  const finite = data.map(p => p.values[key]).filter(Number.isFinite)
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 1
  const span = max - min || Math.max(Math.abs(max) * .1, .01)
  const low = min - span * .12
  const high = max + span * .12
  const x = (i: number) => 28 + i / Math.max(1, data.length - 1) * 844
  const y = (v: number) => 178 - (v - low) / (high - low) * 148
  let penDown = false
  const path = data.map((row, i) => {
    const v = row.values[key]
    if (!Number.isFinite(v)) { penDown = false; return '' }
    const segment = `${penDown ? 'L' : 'M'}${x(i)},${y(v)}`
    penDown = true
    return segment
  }).join(' ')
  const index = cursor === null ? data.length - 1 : Math.min(cursor, data.length - 1)
  const active = data[index]
  const value = active?.values[key]
  const format = (v: number | undefined) => v === undefined || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toExponential(2) : v.toFixed(3)
  const age = active && data.length ? (data[data.length - 1].t - active.t) / 1000 : 0
  return <section className={`video-trace ${glow ? 'has-glow' : ''}`} aria-label="交互特征曲线">
    <div className="video-trace-toolbar">
      <label>观察特征<select value={key} onChange={e => { setSelected(e.target.value); setCursor(null) }} disabled={!keys.length}>
        {keys.length ? keys.map(k => <option key={k} value={k}>{labelForDisplayKey(k)}</option>) : <option value={key}>等待 EEG 特征</option>}
      </select></label>
      <div className="video-trace-options"><label>历史窗口<select value={points} onChange={e => { setPoints(Number(e.target.value)); setCursor(null) }}>{[15, 30, 60].map(n => <option key={n} value={n}>最近 {n} 点</option>)}</select></label>
      <button type="button" className="video-text-button" aria-pressed={glow} onClick={() => setGlow(!glow)}>柔光 {glow ? '开' : '关'}</button></div>
    </div>
    {!history.length && <div className="video-trace-preview"><button className="video-text-button" aria-pressed={showPreview} onClick={() => { setPreview(!preview); setCursor(null) }}>{showPreview ? '退出视觉预览' : '预览曲线光效'}</button><span>{showPreview ? '模拟曲线 · 仅展示交互，不录制、不驱动模型' : '未连接设备也可预览交互效果'}</span></div>}
    <div className="video-trace-readout"><strong>{format(value)}</strong><span>{!data.length ? '尚无数据' : cursor === null ? showPreview ? '模拟预览' : live ? '实时窗口' : '已冻结' : `${age.toFixed(1)} 秒前`}</span><small>原始特征值 · 纵轴自适应</small></div>
    <svg viewBox="0 0 900 220" role="img" aria-label={`${labelForDisplayKey(key)} 曲线；下方滑块可检查历史值`}>
      <defs><filter id={`${uid}-glow`} x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
      <linearGradient id={`${uid}-line`}><stop stopColor="#16a6a1" /><stop offset="1" stopColor="#72c6f5" /></linearGradient></defs>
      {[30, 79, 128, 178].map((line, i) => <g key={line}><line x1="28" x2="872" y1={line} y2={line} className="video-trace-grid" /><text x="30" y={line - 6} className="video-trace-axis">{finite.length ? format(high - i / 3 * (high - low)) : '—'}</text></g>)}
      {data.length > 1 && <>{glow && <path d={path} fill="none" stroke="#39c9c4" strokeWidth="5" opacity=".45" filter={`url(#${uid}-glow)`} />}
        <path d={path} fill="none" stroke={`url(#${uid}-line)`} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>}
      {active && Number.isFinite(value) && <g><line x1={x(index)} x2={x(index)} y1="22" y2="185" className="video-trace-cursor" /><circle cx={x(index)} cy={y(value)} r="5" fill="#49bcb6" stroke="var(--bg)" strokeWidth="2" /></g>}
      {!finite.length && <text x="450" y="112" textAnchor="middle" className="video-trace-empty">连接 EEG 后显示真实曲线</text>}
      <text x="28" y="211" className="video-trace-axis">{data.length > 1 ? `−${((data[data.length - 1].t - data[0].t) / 1000).toFixed(1)} s` : '历史'}</text>
      <text x="872" y="211" textAnchor="end" className="video-trace-axis">{live ? '当前' : '最近窗口'}</text>
      <rect x="28" y="15" width="844" height="175" fill="transparent" onPointerMove={e => { const rect = e.currentTarget.getBoundingClientRect(); setCursor(Math.round(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * Math.max(0, data.length - 1))) }} onPointerLeave={() => setCursor(null)} />
    </svg>
    <div className="video-trace-scrub"><span>检查历史</span><input aria-label="检查特征历史窗口" type="range" min="0" max={Math.max(0, data.length - 1)} value={Math.max(0, index)} disabled={!data.length} onChange={e => setCursor(Number(e.target.value))} /><button className="video-text-button" onClick={() => setCursor(null)}>回到最新</button></div>
  </section>
}
