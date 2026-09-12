import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { sampleClock } from '../../lib/eeg/sampleClock'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { SessionLogger } from '../../lib/logger'
import { randomSeed } from '../../lib/rng'
import { recorderIsActive, startExperimentRecording, stopExperimentRecording } from '../../lib/session/recordControl'
import { loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { copyRecentSamples } from '../smr-adapt/smrControl'
import {
  BASELINE_SEC, TARGET_SEC, DIRECTIONS, DIRECTION_NAMES, evaluateGaze, fitGazeModel,
  gazeFeatures, makePlan, parseGazeModel, predictGaze,
  type Example, type GazeModel, type GazeTrial,
} from './classifier'
import './smrGaze.css'

type Phase = 'idle' | 'starting' | 'baseline' | 'target' | 'break' | 'done'
type Mode = 'train' | 'validate' | 'preview'
type ActiveSession = {
  phase: Phase; mode: Mode; plan: GazeTrial[]; index: number; started: number; lastTick: number
  baseline: Float32Array[]; rows: Example[]; channels: string[]; hz: number; startSample: number
  invalid: string | null; model: GazeModel | null
}
const modelKey = (subject: string) => `passive-bci.gaze-model.v1.${subject}`
function loadModel(subject: string) {
  try { return parseGazeModel(localStorage.getItem(modelKey(subject))) } catch { return null }
}
function readWindow(seconds: number): Float32Array[] {
  const ring = liveEegHub.ring
  return ring.buffers.map((b) => copyRecentSamples(b, ring.writeHead, ring.filled, Math.round(seconds * ring.sampleRate)))
}

export function SmrGazePage() {
  const eeg = useLiveEeg()
  const [subject, setSubject] = useState(() => loadStoredSubjectId('S01'))
  const [phase, setPhase] = useState<Phase>('idle')
  const [trial, setTrial] = useState<GazeTrial | null>(null)
  const [mode, setMode] = useState<Mode>('train')
  const [notice, setNotice] = useState('')
  const [model, setModel] = useState<GazeModel | null>(() => loadModel(subject))
  const [report, setReport] = useState<ReturnType<typeof evaluateGaze> | null>(null)
  const [accepted, setAccepted] = useState(0)
  const [rejected, setRejected] = useState(0)
  const arena = useRef<HTMLDivElement>(null)
  const active = useRef<ActiveSession | null>(null)
  const ownsRecording = useRef(false)
  const busy = useRef(false)
  const starting = useRef(false)
  const generation = useRef(0)
  const logger = useRef(new SessionLogger('smr-gaze', subject))
  const running = !['idle', 'done'].includes(phase)

  const exitFullscreen = () => {
    if (document.fullscreenElement === arena.current) void document.exitFullscreen().catch(() => {})
  }
  const stopRecording = async () => {
    if (!ownsRecording.current) return
    ownsRecording.current = false
    try {
      const result = await stopExperimentRecording()
      setNotice((text) => `${text} ${result.message}`)
    } catch (error) { setNotice((text) => `${text} 保存录制失败：${String(error)}`) }
  }
  const abort = (reason: string) => {
    generation.current += 1
    const state = active.current
    if (state) logger.current.log('session_abort', { reason, trialIndex: state.index, phase: state.phase })
    active.current = null
    setPhase('idle')
    setNotice(`${reason}；未完成试次不用于训练。`)
    exitFullscreen()
    busy.current = true
    void stopRecording().finally(() => { if (!starting.current) busy.current = false })
  }
  const setStage = (state: ActiveSession, next: Phase, now: number) => {
    state.phase = next
    state.started = now
    state.lastTick = now
    setPhase(next)
    setTrial(state.plan[state.index] ?? null)
    logger.current.log('gaze_phase', {
      phase: next, mode: state.mode, ...state.plan[state.index],
      label: state.plan[state.index] ? `gaze_${state.plan[state.index]!.target}` : null,
    })
  }
  const finish = (state: ActiveSession) => {
    active.current = null
    setPhase('done')
    exitFullscreen()
    try {
      if (state.mode === 'preview') {
        setNotice('预览完成，没有采集训练样本。')
      } else if (state.mode === 'validate' && state.model) {
        const result = evaluateGaze(state.model, state.rows)
        setReport(result)
        logger.current.log('gaze_validation', { ...result, modelCreatedAt: state.model.createdAt })
        setNotice('独立验证完成，已有模型未更新。')
      } else {
        const train = state.rows.filter((e) => e.run < 3)
        const heldOut = state.rows.filter((e) => e.run === 3)
        const candidate = fitGazeModel(train, subject, state.channels, state.hz)
        const result = evaluateGaze(candidate, heldOut)
        setReport(result)
        if (result.balancedAccuracy === null) throw new Error('留出组缺少方向，未保存新模型，请重新采集')
        const fitted = fitGazeModel(state.rows, subject, state.channels, state.hz)
        // Save only after every required step has succeeded, preserving the previous model on failure.
        localStorage.setItem(modelKey(subject), JSON.stringify(fitted))
        setModel(fitted)
        logger.current.log('gaze_model', { model: fitted, heldOutRun: 3, evaluation: result })
        setNotice('分类器已保存。下方为前两组训练、第三组留出的结果；最终模型用全部有效试次拟合。可再做独立验证。')
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    logger.current.log('session_end', { mode: state.mode, accepted: state.rows.length })
    busy.current = true
    void stopRecording().finally(() => { busy.current = false })
  }

  const start = async (nextMode: Mode) => {
    if (busy.current || active.current) return
    if (nextMode !== 'preview' && (!eeg.live || eeg.meta.device === 'demo')) {
      setNotice('请先连接真实 EEG 并开始采集。'); return
    }
    if (recorderIsActive()) { setNotice('请先结束当前录制，再开始视线方向采集。'); return }
    if (!subject.trim()) { setNotice('请填写被试编号。'); return }
    const channels = [...liveEegHub.meta.channelNames]
    const hz = liveEegHub.ring.sampleRate
    if (nextMode !== 'preview' && (!channels.length || hz < 20)) { setNotice('当前 EEG 通道或采样率不可用。'); return }
    if (nextMode === 'validate' && (!model || model.subjectId !== subject || model.sampleRate !== hz || model.channels.join('|') !== channels.join('|'))) {
      setNotice('验证需要本被试已保存的模型，且通道顺序和采样率必须与训练一致。'); return
    }
    busy.current = true
    starting.current = true
    const token = ++generation.current
    setPhase('starting'); setMode(nextMode); setNotice(''); setReport(null); setAccepted(0); setRejected(0)
    logger.current = new SessionLogger('smr-gaze', subject)
    const seed = randomSeed()
    try {
      // Request directly from the button gesture, before recording/network awaits.
      if (!arena.current?.requestFullscreen) throw new Error('浏览器不支持全屏，请使用桌面 Chrome 或 Edge')
      await arena.current.requestFullscreen()
      if (token !== generation.current) return
      if (nextMode !== 'preview') {
        const rec = await startExperimentRecording({ experiment: 'smr-gaze', subjectId: subject, seed })
        ownsRecording.current = rec.ok
        if (token !== generation.current) { await stopRecording(); return }
        if (!rec.ok || rec.sink !== 'disk') throw new Error(`${rec.message}；此采集需要同时保存 EEG 和标签，请使用本地开发服务。`)
      }
      const now = performance.now()
      const state: ActiveSession = {
        phase: 'baseline', mode: nextMode, plan: makePlan(seed, nextMode === 'train' ? 3 : 1),
        index: 0, started: now, lastTick: now, baseline: [], rows: [], channels, hz,
        startSample: sampleClock.snapshot()?.sampleIndex ?? 0, invalid: null, model,
      }
      active.current = state
      logger.current.log('session_start', {
        protocol: 'eeg-gaze-v1', mode: nextMode, seed, trials: state.plan, channels, sampleRate: hz,
        baselineSec: BASELINE_SEC, targetSec: TARGET_SEC,
        instructions: '注视中央后直接望向标靶，保持头部不动；无需运动想象',
        eyeTracker: false, labelsAre: 'instructed_gaze_direction',
        screen: { width: arena.current.clientWidth, height: arena.current.clientHeight, devicePixelRatio: window.devicePixelRatio },
      })
      setStage(state, 'baseline', now)
    } catch (error) {
      active.current = null
      starting.current = false
      setPhase('idle'); exitFullscreen()
      setNotice(error instanceof Error ? error.message : String(error))
      await stopRecording()
    } finally { starting.current = false; busy.current = false }
  }

  const tick = useEffectEvent(() => {
      const state = active.current
      if (!state || state.phase === 'break') return
      const now = performance.now()
      if (now - state.lastTick > 400) state.invalid = '页面计时中断'
      state.lastTick = now
      if (state.mode !== 'preview') {
        if (!recorderIsActive()) { abort('录制已停止'); return }
        const meta = liveEegHub.meta
        if (!liveEegHub.isFresh() || now - meta.lastAt > 500 || meta.device === 'demo') state.invalid = 'EEG 中断'
        if (meta.sampleRate !== state.hz || meta.channelNames.join('|') !== state.channels.join('|')) {
          abort('采集通道或采样率发生变化'); return
        }
      }
      const elapsed = (now - state.started) / 1000
      if (state.phase === 'baseline' && elapsed >= BASELINE_SEC) {
        state.baseline = readWindow(1)
        state.startSample = sampleClock.snapshot()?.sampleIndex ?? 0
        setStage(state, 'target', now)
      } else if (state.phase === 'target' && elapsed >= TARGET_SEC) {
        const item = state.plan[state.index]!
        if (state.mode !== 'preview') {
          try {
            if (state.invalid) throw new Error(state.invalid)
            const received = (sampleClock.snapshot()?.sampleIndex ?? 0) - state.startSample
            if (Math.abs(received - state.hz * TARGET_SEC) > state.hz * 0.25) throw new Error('EEG 采样数与试次时长不匹配')
            const features = gazeFeatures(state.baseline, readWindow(TARGET_SEC), state.hz)
            const example = { ...item, features }
            state.rows.push(example)
            setAccepted(state.rows.length)
            const prediction = state.mode === 'validate' && state.model ? predictGaze(state.model, features) : null
            logger.current.log('gaze_trial', { ...example, label: `gaze_${item.target}`, valid: true, prediction, elapsedSec: elapsed })
          } catch (error) {
            setRejected((n) => n + 1)
            logger.current.log('gaze_trial', { ...item, valid: false, reason: String(error) })
          }
        }
        state.index += 1
        state.invalid = null
        if (state.index >= state.plan.length) { finish(state); return }
        setStage(state, state.plan[state.index]!.run !== item.run ? 'break' : 'baseline', now)
      }
  })
  useEffect(() => {
    const id = window.setInterval(() => tick(), 40)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const onFullscreen = () => {
      if (!document.fullscreenElement && (active.current || starting.current)) abort('已退出全屏')
    }
    const onVisibility = () => { if (document.hidden && active.current) abort('页面已切到后台') }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (active.current || starting.current)) {
        event.preventDefault()
        abort('已退出全屏')
      }
    }
    document.addEventListener('fullscreenchange', onFullscreen)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('keydown', onKey)
      generation.current += 1
      if (active.current) {
        logger.current.log('session_abort', { reason: '离开页面' })
        active.current = null
      }
      if (ownsRecording.current) {
        ownsRecording.current = false
        void stopExperimentRecording().catch(() => {})
      }
    }
  // Session callbacks access mutable refs; subscribe once for the page lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const downloadModel = () => {
    if (!model) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url; a.download = `gaze-model-${subject.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="gaze-page">
      <Link to="/smr-adapt">← SMR 适配</Link>
      <h1>全屏视线方向采集</h1>
      <p>看中央光点，标靶出现后直接望向标靶并保持注视。保持头部不动，无需运动想象或眼动仪。</p>
      <LiveEegBadge />
      <div className="gaze-controls">
        <label>被试编号 <input className="input" value={subject} disabled={running} onChange={(e) => {
          setSubject(e.target.value); setModel(loadModel(e.target.value)); setReport(null)
        }} /></label>
        <button className="btn btn-primary" disabled={running} onClick={() => void start('train')}>全屏采集并训练 · 48 次</button>
        <button className="btn" disabled={running || !model} onClick={() => void start('validate')}>独立验证 · 16 次</button>
        <button className="btn" disabled={running} onClick={() => void start('preview')}>预览标靶（不录制）</button>
      </div>
      <p className="muted">中央 2 秒 → 标靶 3 秒。训练分 3 组，每组 16 次，组间可休息；约 4 分钟。按 Esc 中止并保存已录数据。</p>
      {notice ? <p role="status">{notice}</p> : null}
      <div ref={arena} className="gaze-arena" aria-label="全屏注视任务">
        {['baseline', 'target'].includes(phase) ? (
          <>
            <div className={`gaze-dot is-${phase === 'target' ? trial?.target : 'center'}`} />
            <p className="gaze-instruction">{phase === 'baseline' ? '注视中央' : '保持注视标靶'}</p>
            <span className="gaze-progress">{mode === 'preview' ? '预览 · ' : ''}第 {trial?.run} 组 · {(trial?.index ?? 0) + 1}/{mode === 'train' ? 48 : 16}</span>
          </>
        ) : (
          <div className="gaze-center">
            <p>{phase === 'break' ? '本组完成，可以休息、眨眼。' : phase === 'starting' ? '正在准备采集…' : '注视中央 → 直接望向标靶'}</p>
            {phase === 'break' ? <button className="btn btn-primary" onClick={() => {
              if (active.current) setStage(active.current, 'baseline', performance.now())
            }}>继续下一组</button> : null}
          </div>
        )}
        {running ? <button className="gaze-stop btn" onClick={() => abort('手动中止')}>停止 · Esc</button> : null}
      </div>
      <p>有效试次 {accepted} · 剔除 {rejected}。标签表示要求的注视方向，不代表眼动仪测得的实际注视点。</p>
      {report ? <section className="gaze-results">
        <h2>{mode === 'validate' ? '独立验证' : '第三组留出评估'}</h2>
        <p>均衡准确率：{report.balancedAccuracy === null ? '方向不全，无法评估' : `${(report.balancedAccuracy * 100).toFixed(1)}%`} · 有效试次 {report.n} · 四分类机会水平 25%</p>
        <ul>{DIRECTIONS.map((dir, i) => <li key={dir}>{DIRECTION_NAMES[dir]}：召回率 {report.recalls[i] === null ? '无样本' : `${(report.recalls[i]! * 100).toFixed(0)}%`}</li>)}</ul>
      </section> : null}
      <div className="gaze-controls">
        <button className="btn" disabled={running || !model} onClick={downloadModel}>导出分类器 JSON</button>
        <button className="btn" disabled={running} onClick={() => logger.current.download('json')}>导出本轮事件与特征</button>
        <Link className="btn" to="/recordings">查看 EEG 会话</Link>
      </div>
      <p className="muted">当前模型：{model ? `${model.subjectId} · ${model.channels.length} 通道 · ${model.counts.reduce((a, b) => a + b, 0)} 个训练试次` : '尚未训练'}。</p>
    </main>
  )
}
