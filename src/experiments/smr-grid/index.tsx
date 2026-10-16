import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ensureModelService, modelRuntimeHub, modelServiceStatus, modelUrlPresets, useModelRuntime, useTemporalFilter } from '../../lib/model-runtime'
import { modelConfigurationLocked } from '../../lib/model-runtime/modelServiceApi'
import { S04_HEAD } from '../../lib/model-runtime/subjectModels'
import { labelIndexForTarget } from '../smr-adapt/labels'
import { applyDualAxisPolicy, cardinalDirectionAxes, createGrid, GRID_SIGNAL_MAX_AGE_MS, keyboardVelocity, SMR_GRID_STEP_SEC, smrCardinalLogitAxes, smrLogitAxes, softGridAction, stepGrid, targetCenter, validSmrPrediction, type CorridorMode, type DualAxisPolicy, type Point } from './engine'
import { SmrDebugPanel, type GridDebugFrame } from './SmrDebugPanel'
import { finishGridRecording } from './finishRecording'
import { ensureGridBcigoStream } from './ensureBcigoStream'
import './smrGrid.css'

const CONTROL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'])

export function SmrGridPage() {
  const [params] = useSearchParams()
  const [board, setBoard] = useState(() => createGrid())
  const boardRef = useRef(board)
  const [mode, setMode] = useState<'smr' | 'dual' | 'keyboard'>(() => params.get('source') === 'dual' ? 'dual' : 'smr')
  const [dualPolicy, setDualPolicy] = useState<DualAxisPolicy>(() => {
    const policy = params.get('policy')
    return policy === 'target' || policy === 'horizontal' || policy === 'vertical' ? policy : 'simultaneous'
  })
  const [running, setRunning] = useState(false)
  const [gain, setGain] = useState(0.85)
  const [corridor, setCorridor] = useState({ enabled: false, mode: 'hard' as CorridorMode, widthCells: 0.4, strength: 0.25 })
  const [field, setField] = useState<Point>({ x: 0, y: 0 })
  const [signal, setSignal] = useState('等待 SMR 信号')
  const [drive, setDrive] = useState<Point>({ x: 0, y: 0 })
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const keys = useRef(new Set<string>())
  const targetAxis = useRef<{ target: number; axis: 'horizontal' | 'vertical' } | null>(null)
  const connection = useRef<AbortController | null>(null)
  const runtime = useModelRuntime()
  const { filterRef, config: temporalConfig, setConfig: setTemporalConfig } = useTemporalFilter(SMR_GRID_STEP_SEC)
  const [debugFrame, setDebugFrame] = useState<GridDebugFrame>({ prediction: null, decision: null, logitAxes: null, actualVelocity: { x: 0, y: 0 }, sampledAt: 0 })

  useEffect(() => () => connection.current?.abort(), [])

  useEffect(() => {
    if (mode === 'dual') void connectSmr()
    // Switching the source is the trigger; callback identity must not reconnect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  async function connectSmr() {
    const controller = new AbortController()
    connection.current?.abort()
    connection.current = controller
    setConnecting(true)
    setError('')
    try {
      setSignal('正在保存当前录制并连接模型…')
      await finishGridRecording()
      if (controller.signal.aborted) return
      if (mode === 'dual') {
        setSignal('正在保存当前录制并连接双轴模型…')
        setSignal('正在连接 BCIGo 原始数据流…')
        await ensureGridBcigoStream(controller.signal)
        if (controller.signal.aborted) return
      }
      const recordingResponse = await fetch('/api/record/active', { signal: controller.signal })
      if (!recordingResponse.ok) throw new Error('无法确认采集状态，请稍后重试连接。')
      const recording = await recordingResponse.json() as { ok?: boolean; id?: string | null }
      if (controller.signal.aborted) return
      if (!recording.ok) throw new Error('无法确认采集状态，请稍后重试连接。')
      if (recording.id || modelConfigurationLocked()) throw new Error('当前正在采集；请先结束录制，再切换模型连接。')
      if (mode === 'dual') {
        const dualUrl = 'ws://127.0.0.1:8769/v1/model'
        const urlChanged = modelRuntimeHub.snapshot.url !== dualUrl
        modelRuntimeHub.setUrl(dualUrl)
        if (!modelRuntimeHub.snapshot.enabled) modelRuntimeHub.setEnabled(true)
        else if (!urlChanged || modelRuntimeHub.snapshot.status !== 'ready') modelRuntimeHub.connect()
        return
      }
      const status = await modelServiceStatus(controller.signal)
      if (status.running && status.task !== 'smr_control') {
        throw new Error('当前运行的模型不是 SMR 四分类。请先在模型设置中切换为 smr_control，再重新连接。')
      }
      await ensureModelService({ backend: 'reve', task: 'smr_control', headId: S04_HEAD, stepSec: SMR_GRID_STEP_SEC, signal: controller.signal })
      if (controller.signal.aborted) return
      const normalUrl = modelUrlPresets().find(p => p.id === 'proxy')!.url
      const urlChanged = modelRuntimeHub.snapshot.url !== normalUrl
      if (modelRuntimeHub.snapshot.url.includes(':8769')) modelRuntimeHub.setUrl(normalUrl)
      if (!modelRuntimeHub.snapshot.enabled) modelRuntimeHub.setEnabled(true)
      else if (!urlChanged || modelRuntimeHub.snapshot.status !== 'ready') modelRuntimeHub.connect()
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!controller.signal.aborted) setConnecting(false)
    }
  }

  useEffect(() => {
    const release = () => keys.current.clear()
    const pause = () => { release(); setRunning(false) }
    const visibility = () => { if (document.hidden) pause() }
    const down = (event: KeyboardEvent) => {
      if (mode !== 'keyboard' || !running || !CONTROL_KEYS.has(event.code)) return
      const el = event.target as HTMLElement | null
      if (el?.closest('input, select, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      keys.current.add(event.code)
    }
    const up = (event: KeyboardEvent) => { keys.current.delete(event.code) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', pause)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      release()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', pause)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [mode, running])

  useEffect(() => {
    filterRef.current.reset()
  }, [mode, running, filterRef])

  useEffect(() => {
    let last = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      let velocity = { x: 0, y: 0 }
      let logitAxes: Point | null = null
      const frame: GridDebugFrame = { prediction: null, decision: null, logitAxes: null, actualVelocity: { x: 0, y: 0 }, sampledAt: now }
      if (mode === 'keyboard') {
        velocity = keyboardVelocity(keys.current)
        logitAxes = { x: velocity.x * 4, y: velocity.y * 4 }
        setSignal('键盘试玩 · 非脑电控制')
      } else {
        const pred = modelRuntimeHub.latestObservation(GRID_SIGNAL_MAX_AGE_MS)
        if (validSmrPrediction(pred, now, mode === 'dual')) {
          frame.prediction = pred
          if (mode === 'dual') {
            logitAxes = smrLogitAxes(pred)
            if (logitAxes) {
              const previous = targetAxis.current?.target === boardRef.current.target ? targetAxis.current.axis : undefined
              const selected = applyDualAxisPolicy(boardRef.current, logitAxes, dualPolicy, previous)
              if (dualPolicy === 'target' && selected.active !== 'both') targetAxis.current = { target: boardRef.current.target, axis: selected.active }
              else targetAxis.current = null
              logitAxes = selected.axes
              setSignal(selected.active === 'horizontal' ? '当前轴：左右 · 左手 / 右手' : selected.active === 'vertical' ? '当前轴：上下 · 舌头 / 休息' : '双轴同时 · 探索模式')
            }
            velocity = softGridAction(boardRef.current, logitAxes, corridor.widthCells, 0).action
          } else {
          // Canonical names preserve compatibility with the head's label aliases.
          const directions = ['left', 'right', 'up', 'down'] as const
          const indices = directions.map(dir => labelIndexForTarget(pred.class_names, dir)!)
          const decision = filterRef.current.observePrediction({ ...pred,
            class_names: [...directions], probabilities: indices.map(i => pred.probabilities[i]!),
            logits: pred.logits ? indices.map(i => pred.logits![i]!) : undefined })
          frame.prediction = pred
          frame.decision = decision
          logitAxes = corridor.enabled && corridor.mode === 'soft'
            ? smrCardinalLogitAxes(pred)
            : cardinalDirectionAxes(decision.className, decision.ready === false ? 0 : 1)
          velocity = softGridAction(boardRef.current, logitAxes, corridor.widthCells, 0).action
          const directionLabel = { left: '左', right: '右', up: '上', down: '下' }[decision.className]
          setSignal(decision.ready === false ? 'SMR 信号累积中' : `四分类单方向：${directionLabel ?? '—'}`)
          }
        } else {
          filterRef.current.reset()
          setSignal('等待有效 SMR 信号 · 光标保持原位')
        }
      }
      let correction = { x: 0, y: 0 }
      if (corridor.enabled && corridor.mode === 'soft') {
        const mixed = softGridAction(boardRef.current, logitAxes, corridor.widthCells, corridor.strength)
        velocity = mixed.action
        correction = mixed.field
      }
      setField(running ? correction : { x: 0, y: 0 })
      setDrive(running ? velocity : { x: 0, y: 0 })
      frame.logitAxes = logitAxes
      if (running) {
        const previous = boardRef.current
        boardRef.current = stepGrid(previous, velocity, dt, gain, Math.random, corridor.enabled && corridor.mode === 'hard' ? corridor.widthCells : null)
        const seconds = boardRef.current.elapsed - previous.elapsed
        if (seconds > 0) frame.actualVelocity = { x: (boardRef.current.cursor.x - previous.cursor.x) / seconds, y: (boardRef.current.cursor.y - previous.cursor.y) / seconds }
        setBoard(boardRef.current)
      }
      setDebugFrame(frame)
    }, 20)
    return () => window.clearInterval(timer)
  }, [mode, running, gain, corridor, dualPolicy, filterRef])

  function changeCorridor(next: typeof corridor) {
    // Strength changes keep the field fixed; geometry/mode changes never teleport the cursor.
    if (next.enabled !== corridor.enabled || next.mode !== corridor.mode || next.widthCells !== corridor.widthCells) {
      boardRef.current = { ...boardRef.current, corridorStart: { ...boardRef.current.cursor } }
      setBoard(boardRef.current)
    }
    setCorridor(next)
  }

  function reset(n = board.n) {
    setRunning(false)
    keys.current.clear()
    boardRef.current = createGrid(n)
    setBoard(boardRef.current)
    filterRef.current.reset()
  }

  const flash = board.lastHit !== null && board.elapsed - board.lastHit < 0.3
  const targetRow = Math.floor(board.target / board.n) + 1
  const targetCol = board.target % board.n + 1
  const end = targetCenter(board.target, board.n)
  const corridorLength = Math.hypot(end.x - board.corridorStart.x, end.y - board.corridorStart.y) * 1000
  const corridorAngle = Math.atan2(end.y - board.corridorStart.y, end.x - board.corridorStart.x) * 180 / Math.PI
  const corridorRadius = corridor.widthCells / board.n * 500

  return <main className="smrgrid-page">
    <header className="smrgrid-header">
      <Link to="/" className="smrgrid-back">← 实验目录</Link>
      <span className="smrgrid-eyebrow">SMR / CONTINUOUS CONTROL</span>
      <h1>二维棋盘追踪</h1>
      <p>移动到亮起的格子。命中后，从当前位置继续追踪下一个目标。</p>
    </header>
    <div className="smrgrid-layout">
      <section className="smrgrid-stage" aria-label="连续光标控制任务">
        <div className="smrgrid-stage-heading"><span>{board.n} × {board.n} 棋盘</span><span>{running ? '连续控制中' : '已暂停'} · {mode !== 'keyboard' ? 'SMR' : '键盘'}</span></div>
        <div className={`smrgrid-board${flash ? ' is-hit' : ''}`} role="img" aria-label={`目标第 ${targetRow} 行、第 ${targetCol} 列；已命中 ${board.hits} 次`}>
          <div className="smrgrid-cells" style={{ gridTemplateColumns: `repeat(${board.n}, 1fr)`, gridTemplateRows: `repeat(${board.n}, minmax(0, 1fr))` }}>
            {Array.from({ length: board.n * board.n }, (_, i) => <div key={i} className={`smrgrid-cell${i === board.target ? ' is-target' : ''}${(Math.floor(i / board.n) + i % board.n) % 2 ? ' is-dark' : ''}`}>
              {i === board.target && <span className="smrgrid-target-mark">＋</span>}
            </div>)}
          </div>
          {corridor.enabled && <svg className="smrgrid-corridor" viewBox="0 0 1000 1000" aria-hidden="true">
            <g transform={`translate(${board.corridorStart.x * 1000} ${board.corridorStart.y * 1000}) rotate(${corridorAngle})`}>
              <rect className="smrgrid-corridor-area" x={-corridorRadius} y={-corridorRadius} width={corridorLength + corridorRadius * 2} height={corridorRadius * 2} rx={corridorRadius} />
              <line className="smrgrid-corridor-axis" x1="0" y1="0" x2={corridorLength} y2="0" />
              <circle className="smrgrid-corridor-origin" r="5" />
            </g>
          </svg>}
          <div className="smrgrid-cursor" style={{ left: `${board.cursor.x * 100}%`, top: `${board.cursor.y * 100}%` }} />
        </div>
        <div className="smrgrid-stage-footer"><span>目标 {targetRow} 行 · {targetCol} 列</span><span aria-live="polite">{flash ? '✓ 命中！继续下一格' : '光标中心进入亮格即命中'}</span></div>
      </section>
      <aside className="smrgrid-panel">
        <div className="smrgrid-score"><div><strong>{board.hits}</strong><span>命中目标</span></div><div><strong>{Math.floor(board.elapsed)}<small> s</small></strong><span>任务时间</span></div></div>
        <div className="smrgrid-actions"><button className="smrgrid-primary" onClick={() => setRunning(v => !v)}>{running ? '暂停' : board.elapsed > 0 ? '继续' : '开始'}</button><button onClick={() => reset()}>重置</button></div>
        <label>控制来源<select value={mode} onChange={e => { connection.current?.abort(); setConnecting(false); setError(''); setRunning(false); setMode(e.target.value as typeof mode); keys.current.clear() }}><option value="smr">SMR 四分类 · 单方向</option><option value="dual">双二分类 · 水平 + 垂直</option><option value="keyboard">键盘试玩</option></select></label>
        {mode === 'dual' && <label>二分类控制策略<select value={dualPolicy} onChange={e => { targetAxis.current = null; setDualPolicy(e.target.value as DualAxisPolicy) }}><option value="simultaneous">双轴同时 · X / Y</option><option value="horizontal">仅左右 · 校验左右模型</option><option value="vertical">仅上下 · 校验上下模型</option><option value="target">目标主轴 · 可选约束</option></select></label>}
        <p className="smrgrid-signal" role="status">{signal}</p>
        {mode !== 'keyboard' && <><button onClick={() => void connectSmr()} disabled={connecting}>{connecting ? '正在连接…' : mode === 'dual' ? '连接双轴模型' : '连接 SMR 模型'}</button><p className="smrgrid-help">{mode === 'dual' ? '左右模型控制水平轴，上下模型控制垂直轴；两个轴可同时产生动作。' : <>四分类头每次只选择上、下、左、右中的一个方向。先在 <Link to="/acquisition">采集调试</Link> 连接设备并开流。</>}</p></>}
        {error && <p className="smrgrid-error" role="alert">{error}</p>}
        {mode === 'dual' && runtime.url.includes(':8769') && runtime.lastError && <p className="smrgrid-error" role="alert">{runtime.lastError}。可在下方调试板查看双轴服务启动方式。</p>}
        <label>棋盘大小<select value={board.n} onChange={e => reset(Number(e.target.value))}>{[3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n} × {n}</option>)}</select></label>
        <label>移动速度 <output>{gain.toFixed(2)}×</output><input type="range" min="0.3" max="2" step="0.05" value={gain} onChange={e => setGain(Number(e.target.value))} /></label>
        <div className="smrgrid-assistance">
          <label className="smrgrid-toggle"><input type="checkbox" checked={corridor.enabled} onChange={e => changeCorridor({ ...corridor, enabled: e.target.checked })} />连线约束</label>
          {corridor.enabled && <label>约束模式<select value={corridor.mode} onChange={e => changeCorridor({ ...corridor, mode: e.target.value as CorridorMode })}><option value="hard">硬约束 · 限制在通道内</option><option value="soft">软约束 · 弱向量场回推</option></select></label>}
          {corridor.enabled && <label>通道宽度 <output>{corridor.widthCells.toFixed(2)} 格</output><input aria-label="通道宽度" type="range" min="0.1" max="1" step="0.05" value={corridor.widthCells} onChange={e => changeCorridor({ ...corridor, widthCells: Number(e.target.value) })} /></label>}
          {corridor.enabled && corridor.mode === 'soft' && <>
            <label>回推强度 <output>{corridor.strength.toFixed(2)}</output><input aria-label="回推强度" type="range" min="0" max="1" step="0.05" value={corridor.strength} onChange={e => changeCorridor({ ...corridor, strength: Number(e.target.value) })} /></label>
          </>}
          <p className="smrgrid-help">{corridor.enabled ? corridor.mode === 'soft' ? '靠近或超出蓝色边界时，弱向量场向内回推；可越界。回推向量与每次 logits 的方向差叠加后生成动作。信号中断时停止。' : '光标中心限制在蓝色通道内；越窄，自由度越低。每个目标固定一条连线，命中后更新。调整宽度时从当前位置重建。' : '可将光标限制在起点与目标格中心之间的通道内。'}</p>
          {corridor.enabled && corridor.mode === 'soft' && <details className="smrgrid-formula"><summary>动作合成方式</summary>{mode === 'smr' ? <p>四分类只保留本次 logit 最高的方向及其领先差值，另一个轴保持为零。<br />动作 = 0.25 × tanh(单方向差值 + 回推量)<br />并列第一时不产生分类动作。未提供 logits 时使用 log(概率)。</p> : <p>水平：(右 logit − 左 logit) / 2<br />垂直：(休息 logit − 舌头 logit) / 2<br />动作 = 0.25 × tanh(方向差 + 回推量)<br />双二分类可同时产生水平和垂直动作；键盘以方向值代替方向差。</p>}</details>}
        </div>
        <div className="smrgrid-instructions"><strong>{mode !== 'keyboard' ? '运动想象方向' : '按住方向键移动'}</strong><p>{mode !== 'keyboard' ? '左手 ←　右手 →\n舌头 ↑　休息 ↓' : '← ↑ ↓ → 或 W A S D\n可同时按两个方向，斜向移动。'}</p><span>{mode === 'smr' ? '四分类每次只执行一个方向' : mode === 'dual' ? '水平与垂直可同时控制' : '命中后不回中 · 无试次间休息'}</span></div>
        <div className="smrgrid-drive">水平 {(drive.x * 4).toFixed(2)} <span>／</span> 垂直 {(-drive.y * 4).toFixed(2)}</div>
      </aside>
    </div>
    <SmrDebugPanel frame={debugFrame} runtime={runtime} config={temporalConfig} onConfigChange={setTemporalConfig} soft={corridor.enabled && corridor.mode === 'soft'} running={running} source={mode} dualPolicy={dualPolicy} drive={drive} correction={field} />
  </main>
}
