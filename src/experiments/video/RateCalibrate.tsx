import { useEffect, useRef, useState } from 'react'
import { displayValueForDriver, resolveDriverRaw } from '../../lib/features/controlMapping'

type Latest = { values: Record<string, number> } | null

export type CalibStats = {
  threshold: number
  accuracy: number
  focusMean: number
  relaxMean: number
  cohenD: number
  focusN: number
  relaxN: number
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }
function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length)
}

/** Sweep midpoints; pick the threshold with the best balanced accuracy (focus above, relax below). */
function calibrate(focus: number[], relax: number[]): CalibStats | null {
  if (!focus.length || !relax.length) return null
  const all = [...focus, ...relax].sort((a, b) => a - b)
  const fm = mean(focus), rm = mean(relax)
  let best = { t: (fm + rm) / 2, acc: -1 }
  for (let i = 0; i < all.length - 1; i++) {
    const t = (all[i]! + all[i + 1]!) / 2
    const tp = focus.filter((v) => v > t).length / focus.length
    const tn = relax.filter((v) => v <= t).length / relax.length
    const acc = (tp + tn) / 2
    if (acc > best.acc) best = { t, acc }
  }
  const pooled = Math.sqrt((std(focus) ** 2 + std(relax) ** 2) / 2)
  return {
    threshold: best.t,
    accuracy: best.acc,
    focusMean: fm,
    relaxMean: rm,
    cohenD: pooled > 1e-9 ? (fm - rm) / pooled : 0,
    focusN: focus.length,
    relaxN: relax.length,
  }
}

type Phase = { kind: 'focus' | 'relax'; round: number }

export function RateCalibrate({ driver, latest, onApply, onClose }: {
  driver: string
  latest: Latest
  onApply: (inMin: number, inMax: number, stats: CalibStats) => void
  onClose: () => void
}) {
  const [rounds, setRounds] = useState(3)
  const [seconds, setSeconds] = useState(8)
  const [buffer, setBuffer] = useState(3)
  const [phase, setPhase] = useState<Phase | null>(null)
  const [left, setLeft] = useState(0)
  const [collecting, setCollecting] = useState(false)
  const collectingRef = useRef(false)
  const samples = useRef<{ focus: number[]; relax: number[] }>({ focus: [], relax: [] })
  const [stats, setStats] = useState<CalibStats | null>(null)
  const [inRange, setInRange] = useState<{ inMin: number; inMax: number } | null>(null)

  const seq: Phase[] = []
  for (let r = 0; r < rounds; r++) { seq.push({ kind: 'relax', round: r + 1 }); seq.push({ kind: 'focus', round: r + 1 }) }

  // Collect the driver display-value on every new feature tick, but only after
  // the per-round settle buffer so early-state samples don't contaminate.
  useEffect(() => {
    if (!phase || !latest || !collectingRef.current) return
    const raw = resolveDriverRaw(latest.values, driver)
    if (raw === undefined) return
    const v = displayValueForDriver(driver, raw)
    if (Number.isFinite(v)) samples.current[phase.kind].push(v)
  }, [latest, phase, driver])

  useEffect(() => {
    if (!phase) return
    const t0 = performance.now()
    const id = window.setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000
      const collecting = elapsed >= buffer
      collectingRef.current = collecting
      setCollecting(collecting)
      setLeft(Math.max(0, buffer + seconds - elapsed))
      if (elapsed >= buffer + seconds) {
        window.clearInterval(id)
        const idx = seq.indexOf(phase)
        if (idx + 1 < seq.length) setPhase(seq[idx + 1]!)
        else {
          setPhase(null)
          const result = calibrate(samples.current.focus, samples.current.relax)
          setStats(result)
          if (result && result.focusMean > result.relaxMean) {
            const half = Math.max(result.threshold - result.relaxMean, result.focusMean - result.threshold) || 1e-6
            setInRange({ inMin: result.threshold - half, inMax: result.threshold + half })
          }
        }
      }
    }, 100)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const start = () => {
    samples.current = { focus: [], relax: [] }
    setStats(null)
    setInRange(null)
    setPhase(seq[0] ?? null)
  }

  return (
    <div className="video-calib-overlay" role="dialog" aria-modal="true"
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)' }}>
      <div className="video-calib-dialog" style={{ background: 'var(--bg, #10141c)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: 420, maxWidth: '92vw' }}>
        {!phase && !stats && <>
          <h2 className="m-0 text-lg font-semibold">专注度阈值校准</h2>
          <p className="muted text-sm">按提示交替进入「放松 / 专注」状态，每轮采集驱动特征 <code>{driver}</code>，完成后自动计算最大分割阈值并映射到控制值 50。</p>
          <label className="video-field">每状态轮数<select className="input" value={rounds} onChange={e => setRounds(Number(e.target.value))}>{[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}</select></label>
          <label className="video-field">每轮采集秒数<select className="input" value={seconds} onChange={e => setSeconds(Number(e.target.value))}>{[5, 8, 10, 15, 20].map(n => <option key={n}>{n}</option>)}</select></label>
          <label className="video-field">每轮缓冲秒数（不采集）<select className="input" value={buffer} onChange={e => setBuffer(Number(e.target.value))}>{[0, 2, 3, 5, 8].map(n => <option key={n}>{n}</option>)}</select></label>
          <p className="muted text-xs">共 {seq.length} 轮，放松/专注交叉各 {rounds} 轮，每轮 {buffer}s 进入状态 + {seconds}s 采集，约 {Math.round(seq.length * (buffer + seconds))} 秒。期间可保持视频播放。</p>
          <div className="flex gap-2"><button className="btn btn-primary" onClick={start}>开始校准</button><button className="btn" onClick={onClose}>取消</button></div>
        </>}
        {phase && <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div className="muted text-sm">第 {phase.round}/{rounds} 轮 · {phase.kind === 'relax' ? '放松' : '专注'}</div>
          <div style={{ fontSize: 44, fontWeight: 700, margin: '12px 0' }}>{phase.kind === 'relax' ? '请放松' : '请专注'}</div>
          <div style={{ fontSize: 28 }}>{left.toFixed(1)}s</div>
          <p className="muted text-xs">{collecting ? `采集中 · 已采集 ${samples.current[phase.kind].length} 个特征样本` : '进入状态…（缓冲不采集）'}</p>
          <button className="btn" onClick={() => { setPhase(null); setStats(null) }}>中止</button>
        </div>}
        {stats && !phase && <>
          <h2 className="m-0 text-lg font-semibold">校准结果</h2>
          <p className="muted text-sm">
            阈值 <strong>{stats.threshold.toFixed(3)}</strong> · 平衡准确率 <strong>{(stats.accuracy * 100).toFixed(1)}%</strong> · Cohen&apos;s d <strong>{stats.cohenD.toFixed(2)}</strong><br />
            专注均值 {stats.focusMean.toFixed(3)}（{stats.focusN} 样本）· 放松均值 {stats.relaxMean.toFixed(3)}（{stats.relaxN} 样本）
          </p>
          {inRange
            ? <p className="muted text-xs">应用后量程 [{inRange.inMin.toFixed(3)}, {inRange.inMax.toFixed(3)}]，阈值映射到控制值 50；放松均值≈{(50 - (50 * (inRange.inMin - stats.threshold) / (inRange.inMax - inRange.inMin) * -1)).toFixed(0)} 以下、专注均值以上驱动更高倍速。</p>
            : <p className="m-0 text-xs" style={{ color: 'var(--warn)' }}>专注均值 ≤ 放松均值，该特征方向不对或两个状态不可分。建议更换驱动特征后重新校准。</p>}
          <div className="flex gap-2">
            {inRange && <button className="btn btn-primary" onClick={() => { onApply(inRange.inMin, inRange.inMax, stats); onClose() }}>应用阈值</button>}
            <button className="btn" onClick={start}>重测</button>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        </>}
      </div>
    </div>
  )
}
