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
import { DIRECTIONS, DIRECTION_NAMES, makePlan, makeLeftRightPlan, type Direction, type GazeTrial } from './classifier'
import { BASELINE_SEC, TARGET_SEC, gazeModel, connectGazeModel, gazePrediction, type GazeReport } from './reveGaze'
import './smrGaze.css'
import { CONTROL_SPEED_PER_SEC, CONTROL_TARGET_SEC, moveProbabilityCursor, reachedEdge, type CursorPosition } from './cursor'

type Phase = 'idle' | 'starting' | 'baseline' | 'target' | 'feedback' | 'control' | 'break' | 'done'
type Mode = 'train' | 'validate' | 'feedback' | 'control' | 'preview'
const FEEDBACK_SEC = 1.5
type ActiveSession = {
  phase: Phase; mode: Mode; plan: GazeTrial[]; index: number; started: number; lastTick: number
  stem: string; rows: (GazeTrial & { prediction: Direction | null })[]; channels: string[]; hz: number; startSample: number
  invalid: string | null; model: GazeReport | null
  control: { position: CursorPosition; direction: Direction | null; lastDecode: number; readySample: number; hit: boolean; hits: number } | null
}
const MI = { left: '注视左侧，同时想象左手运动', right: '注视右侧，同时想象右手运动', up: '注视上方，同时想象双手运动', down: '注视下方，放松休息' }

export function SmrGazePage() {
  const eeg = useLiveEeg()
  const [subject, setSubject] = useState(() => loadStoredSubjectId('S01'))
  const [phase, setPhase] = useState<Phase>('idle')
  const [trial, setTrial] = useState<GazeTrial | null>(null)
  const [collection, setCollection] = useState('four')
  const [totalTrials, setTotalTrials] = useState(48)
  const [mode, setMode] = useState<Mode>('train')
  const [notice, setNotice] = useState('')
  const [model, setModel] = useState<GazeReport | null>(null)
  const [report, setReport] = useState<GazeReport['evaluation'] | null>(null)
  const [accepted, setAccepted] = useState(0)
  const [rejected, setRejected] = useState(0)
  const [prediction, setPrediction] = useState<Direction | null>(null)
  const [feedbackError, setFeedbackError] = useState('')
  const [fitting, setFitting] = useState(false)
  useEffect(() => { void gazeModel().then(setModel).catch(e => setNotice(String(e))) }, [])
  const [savingExisting, setSavingExisting] = useState(false)
  const [cursor, setCursor] = useState<CursorPosition>({ x: 0.5, y: 0.5 })
  const [hit, setHit] = useState(false)
  const [hits, setHits] = useState(0)
  const arena = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLDivElement>(null)
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
    const result = await stopExperimentRecording()
    if (!result.ok) throw new Error(result.message)
    return result
  }

  const abort = (reason: string) => {
    generation.current += 1
    const state = active.current
    if (state) logger.current.log('session_abort', { reason, trialIndex: state.index, phase: state.phase })
    active.current = null
    setPhase('idle')
    setNotice(state?.mode === 'control' ? `${reason}；已结束持续光标控制。` : `${reason}；未完成试次不用于训练。`)
    exitFullscreen()
    busy.current = true
    void stopRecording().catch(e => setNotice(String(e))).finally(() => { if (!starting.current) busy.current = false })
  }
  const setStage = (state: ActiveSession, next: Phase, now: number) => {
    state.phase = next
    state.started = now
    state.lastTick = now
    setPhase(next)
    if (next === 'baseline') { setPrediction(null); setFeedbackError('') }
    if (next === 'baseline' && state.control) {
      state.control.position = { x: 0.5, y: 0.5 }
      state.control.hit = false
      setCursor(state.control.position); setHit(false)
    }
    setTrial(state.plan[state.index] ?? null)
    logger.current.log('gaze_phase', {
      phase: next, mode: state.mode, ...state.plan[state.index],
      label: state.plan[state.index] ? `gaze_${state.plan[state.index]!.target}` : null,
    })
  }
  const finish = async (state: ActiveSession) => {
    active.current = null
    setPhase('done')
    exitFullscreen()
    busy.current = true
    logger.current.log('session_end', { mode: state.mode, accepted: state.rows.length })
    try {
      await stopRecording()
      if (state.mode === 'train') {
        setFitting(true)
        setNotice('EEG 已保存，正在冻结 REVE＋LoRA、重新初始化并训练 LP 头…')
        if (!state.stem) throw new Error('缺少会话路径，无法训练')
        const fitted = await gazeModel(state.stem, subject)
        if (!fitted) throw new Error('训练未返回模型')
        setModel(fitted); setReport(fitted.evaluation)
        await connectGazeModel()
        setNotice('REVE＋LP 新头已上线。下方为第三组留出评估，最终头使用本轮全部有效试次训练。')
      } else if (state.mode === 'validate' || state.mode === 'feedback') {
        const recalls = (state.model?.activeClasses?.length === 2 ? DIRECTIONS.slice(0,2) : DIRECTIONS).map(d => {
          const rows = state.rows.filter(r => r.target === d)
          return rows.length ? rows.filter(r => r.prediction === d).length / rows.length : null
        })
        setReport({ n: state.rows.length, recalls, balancedAccuracy: recalls.every(v => v !== null) ? recalls.reduce<number>((a,b) => a + b!, 0) / recalls.length : null })
        setNotice('REVE 评估完成；光标反馈模式的结果不作为独立验证。')
      } else if (state.control) setNotice(`边靶控制完成：命中 ${state.control.hits}/${state.plan.length}。数据已保存，不自动用于训练。`)
      else setNotice('预览完成。')
    } catch (error) { setNotice(String(error)) }
    finally { busy.current = false; setFitting(false) }
  }

  const advanceTrial = (state: ActiveSession, now: number) => {
    const item = state.plan[state.index]!
    state.index += 1
    state.invalid = null
    if (state.index >= state.plan.length) { void finish(state); return }
    setStage(state, state.plan[state.index]!.run !== item.run ? 'break' : 'baseline', now)
  }

  const finishExistingRecording = async () => {
    if (busy.current || active.current) return
    busy.current = true
    setSavingExisting(true)
    setNotice('正在保存当前录制…')
    try {
      const result = await stopExperimentRecording()
      setNotice(`${result.message}；EEG 连接保持，可开始新的眼动任务。`)
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { busy.current = false; setSavingExisting(false) }
  }

  const recenter = () => {
    const state = active.current
    if (!state?.control) return
    state.control.position = { x: 0.5, y: 0.5 }
    state.control.direction = null
    state.invalid = null
    setCursor(state.control.position)
    logger.current.log('gaze_recenter', {})
    setStage(state, 'baseline', performance.now())
  }

  const start = async (nextMode: Mode) => {
    if (busy.current || active.current) return
    const closedLoop = nextMode === 'train' || nextMode === 'control'
    if (nextMode !== 'preview' && (!eeg.live || eeg.meta.device === 'demo')) {
      setNotice('请先连接真实 EEG 并开始采集。'); return
    }
    if (recorderIsActive()) { setNotice('当前已有录制，请先点「保存并结束当前录制」，再开始眼动任务；无需停止 EEG 采集。'); return }
    if (!subject.trim()) { setNotice('请填写被试编号。'); return }
    const channels = [...liveEegHub.meta.channelNames]
    const hz = liveEegHub.ring.sampleRate
    if (nextMode !== 'preview' && (!channels.length || hz < 20)) { setNotice('当前 EEG 通道或采样率不可用。'); return }
    if ((nextMode === 'validate' || nextMode === 'feedback' || closedLoop) && (!model || model.subjectId !== subject || model.sampleRate !== hz || model.channels.join('|') !== channels.join('|'))) {
      setNotice('闭环采集需要本被试已有的 REVE 头，且通道顺序、采样率一致；请先加载初始头。'); return
    }
    if (nextMode === 'train' && collection === 'four' && model?.activeClasses?.length === 2) {
      setNotice('当前为左右二分类头，请选择左右采集；四方向闭环采集需要先加载四方向头。'); return
    }
    busy.current = true
    starting.current = true
    const token = ++generation.current
    setPhase('starting'); setMode(nextMode); setNotice(''); setReport(null); setAccepted(0); setRejected(0); setPrediction(null); setFeedbackError('')
    setCursor({ x: 0.5, y: 0.5 })
    setHit(false); setHits(0)
    logger.current = new SessionLogger('smr-gaze', subject)
    const seed = randomSeed()
    let stem = ''
    try {
      // Request directly from the button gesture, before recording/network awaits.
      if (!arena.current?.requestFullscreen) throw new Error('浏览器不支持全屏，请使用桌面 Chrome 或 Edge')
      await arena.current.requestFullscreen()
      if (token !== generation.current) return
      if (['train', 'validate', 'feedback', 'control'].includes(nextMode)) await connectGazeModel()
      if (token !== generation.current) return
      if (nextMode !== 'preview') {
        const rec = await startExperimentRecording({ experiment: 'smr-gaze', subjectId: subject, seed })
        stem = rec.rel?.split(/[\\/]/).filter(Boolean).pop() ?? ''
        ownsRecording.current = rec.ok
        if (token !== generation.current) { await stopRecording(); return }
        if (!rec.ok || rec.sink !== 'disk') throw new Error(`${rec.message}；此采集需要同时保存 EEG 和标签，请使用本地开发服务。`)
      }
      const now = performance.now()
      const state: ActiveSession = {
        phase: 'baseline', mode: nextMode, plan: collection !== 'four' && (nextMode === 'train' || nextMode === 'preview') ? makeLeftRightPlan(seed, collection === 'lr10' ? 10 : 20) : model?.activeClasses?.length === 2 && nextMode !== 'train' ? makeLeftRightPlan(seed, 10) : makePlan(seed, nextMode === 'train' ? 3 : 1),
        index: 0, started: now, lastTick: now, stem, rows: [], channels, hz,
        startSample: sampleClock.snapshot()?.sampleIndex ?? 0, invalid: null, model,
        control: closedLoop ? { position: { x: 0.5, y: 0.5 }, direction: null, lastDecode: 0, readySample: 0, hit: false, hits: 0 } : null,
      }
      setTotalTrials(state.plan.length)
      active.current = state
      logger.current.log('session_start', {
        protocol: nextMode === 'train' ? 'gaze-assisted-smr-closed-loop-v1' : nextMode === 'control' ? 'gaze-assisted-smr-control-v1' : 'gaze-assisted-smr-v1', mode: nextMode, seed, trials: state.plan, channels, sampleRate: hz,
        baselineSec: BASELINE_SEC, targetSec: closedLoop ? CONTROL_TARGET_SEC : TARGET_SEC,
        feedbackSec: nextMode === 'feedback' || closedLoop ? FEEDBACK_SEC : 0,
        activeClasses: [...new Set(state.plan.map(t => t.target))].sort((a,b) => DIRECTIONS.indexOf(a)-DIRECTIONS.indexOf(b)),
        targetLayout: 'single-edge-v1', targetBandFraction: 0.06,
        predictionVisible: nextMode === 'feedback' || closedLoop,
        continuous: closedLoop ? { windowSec: 2, decodeHopSec: 0.2, speedPerSec: CONTROL_SPEED_PER_SEC, modelRevision: model?.modelRevision } : null,
        instructions: MI, modelType: 'reve', task: 'gaze_smr',
        eyeTracker: false, labelsAre: closedLoop ? 'cued_edge_control_with_feedback' : 'instructed_gaze_assisted_smr_direction',
        screen: { width: arena.current.clientWidth, height: arena.current.clientHeight, devicePixelRatio: window.devicePixelRatio },
        field: { width: field.current?.clientWidth, height: field.current?.clientHeight },
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
      const tickGap = now - state.lastTick
      if (tickGap > 400) state.invalid = '页面计时中断'
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
      if (state.control && state.model) {
        const control = state.control
        if (state.phase === 'feedback') {
          if (elapsed >= FEEDBACK_SEC) advanceTrial(state, now)
          return
        }
        if (state.phase === 'control' && elapsed >= CONTROL_TARGET_SEC) {
          logger.current.log('gaze_edge_result', { ...state.plan[state.index], hit: control.hit, position: control.position, elapsedSec: elapsed, signalIssue: state.invalid })
          if (state.mode === 'train') {
            if (!state.invalid) { state.rows.push({ ...state.plan[state.index]!, prediction: control.direction }); setAccepted(state.rows.length) }
            else setRejected(n => n + 1)
          }
          setStage(state, 'feedback', now)
          return
        }
        if (control.hit) return
        const sample = sampleClock.snapshot()?.sampleIndex ?? 0
        if (tickGap > 400 || !liveEegHub.isFresh() || now - liveEegHub.meta.lastAt > 500) {
          control.direction = null
          control.readySample = sample + Math.round(state.hz * 2)
          if (state.phase === 'baseline') state.started = now
          setPrediction(null)
          setFeedbackError('信号或页面计时中断，光标已停止')
          return
        }
        if (state.phase === 'baseline') {
          if (elapsed >= BASELINE_SEC && liveEegHub.ring.filled >= state.hz) {
            control.readySample = sample + Math.round(state.hz * 2)
            control.lastDecode = 0
            state.invalid = null
            setStage(state, 'control', now)
          }
          return
        }
        if (sample < control.readySample) {
          setFeedbackError('等待完整 2 秒 REVE EEG 窗口…')
          return
        }
        const subset = [...new Set(state.plan.map(t => t.target))]
        const decodeModel = subset.length === 2 ? { ...state.model, activeClasses: ['left', 'right'] } : state.model
        const decoded = gazePrediction(decodeModel, state.started + 2000)
        if (!decoded) { setFeedbackError('等待当前 REVE LP 的有效预测，光标已停止'); return }
        control.direction = DIRECTIONS[decoded.probabilities.indexOf(Math.max(...decoded.probabilities))]!
        setPrediction(control.direction); setFeedbackError('')
        if (decoded.received_at_ms !== control.lastDecode) {
          control.lastDecode = decoded.received_at_ms
          logger.current.log('gaze_control', { direction: control.direction, probabilities: decoded.probabilities, position: control.position, modelRevision: decoded.model_revision })
        }
        control.position = moveProbabilityCursor(control.position, decoded.probabilities, tickGap / 1000)
        setCursor(control.position)
        if (reachedEdge(control.position, state.plan[state.index]!.target)) {
          control.hit = true; control.hits += 1
          setHit(true); setHits(control.hits)
          logger.current.log('gaze_edge_hit', { ...state.plan[state.index], position: control.position, elapsedSec: elapsed })
        }
        return
      }
      if (state.phase === 'feedback') {
        if (elapsed >= FEEDBACK_SEC) advanceTrial(state, now)
        return
      }
      if (state.phase === 'baseline' && elapsed >= BASELINE_SEC) {
        state.startSample = sampleClock.snapshot()?.sampleIndex ?? 0
        setStage(state, 'target', now)
      } else if (state.phase === 'target' && elapsed >= TARGET_SEC) {
        const item = state.plan[state.index]!
        if (state.mode !== 'preview') {
          try {
            if (state.invalid) throw new Error(state.invalid)
            const received = (sampleClock.snapshot()?.sampleIndex ?? 0) - state.startSample
            if (Math.abs(received - state.hz * TARGET_SEC) > state.hz * 0.25) throw new Error('EEG 采样数与试次时长不匹配')
            const output = state.model && (state.mode === 'validate' || state.mode === 'feedback') ? gazePrediction(state.model, state.started + 2000) : null
            if ((state.mode === 'validate' || state.mode === 'feedback') && !output) throw new Error('没有当前 REVE LP 的有效预测')
            const decoded = output ? DIRECTIONS[output.probabilities.indexOf(Math.max(...output.probabilities))]! : null
            const example = { ...item, prediction: decoded }
            state.rows.push(example)
            setAccepted(state.rows.length)
            logger.current.log('gaze_trial', { ...example, label: `gaze_${item.target}`, valid: true, prediction: decoded, elapsedSec: elapsed })
            if (state.mode === 'feedback') {
              setPrediction(decoded)
              logger.current.log('gaze_feedback', { ...item, prediction: decoded, modelRevision: state.model?.modelRevision })
            }
          } catch (error) {
            setRejected((n) => n + 1)
            setPrediction(null)
            setFeedbackError(error instanceof Error ? error.message : String(error))
            logger.current.log('gaze_trial', { ...item, valid: false, reason: String(error) })
          }
        }
        if (state.mode === 'feedback') setStage(state, 'feedback', now)
        else advanceTrial(state, now)
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
      <Link to="/smr-adapt">← SMR 适配</Link> · <Link to="/gaze-smr-tetris">眼动 SMR 俄罗斯方块</Link> · <Link to="/gaze-tetris">眼动版俄罗斯方块</Link>
      <h1>REVE 眼动辅助 SMR</h1>
      <p>采集时实时控制蓝色光标：中央准备 3 秒，亮边后有 12 秒将光标移到目标边。左：注视＋左手运动想象；右：注视＋右手运动想象；上：注视＋双手运动想象；下：注视＋放松休息。</p>
      <LiveEegBadge />
      <div className="gaze-controls">
        <label>采集方案 <select value={collection} disabled={running || fitting} onChange={e => setCollection(e.target.value)}>
          <option value="four">四方向 · 各 12 次</option><option value="lr10">左右二分类 · 各 10 次</option><option value="lr20">左右二分类 · 各 20 次</option>
        </select></label>
        <label>被试编号 <input className="input" value={subject} disabled={running || savingExisting || fitting} onChange={(e) => {
          setSubject(e.target.value); setReport(null)
        }} /></label>
        <button className="btn btn-primary" disabled={running || savingExisting || fitting} onClick={() => void start('train')}>全屏采集并训练 · {collection === 'four' ? 48 : collection === 'lr10' ? 20 : 40} 次</button>
        <button className="btn" disabled={running || savingExisting || fitting || !model} onClick={() => void start('validate')}>独立验证 · {model?.activeClasses?.length === 2 ? 20 : 16} 次</button>
        <button className="btn" disabled={running || savingExisting || fitting || !model} onClick={() => void start('feedback')}>光标反馈 · {model?.activeClasses?.length === 2 ? 20 : 16} 次</button>
        <button className="btn btn-primary" disabled={running || savingExisting || fitting || !model} onClick={() => void start('control')}>持续光标控制</button>
        <button className="btn" disabled={running || savingExisting || fitting} onClick={() => void start('preview')}>预览标靶（不录制）</button>
        {!running && (recorderIsActive() || savingExisting) ? <button className="btn" disabled={savingExisting} onClick={() => void finishExistingRecording()}>{savingExisting ? '正在保存…' : '保存并结束当前录制'}</button> : null}
      </div>
      <p className="muted">闭环采集：准备 3 秒 → 实时控球 12 秒 → 结果 1.5 秒。左右共 20／40 次，分三组（8＋8＋4／16＋16＋8）；四方向共 48 次。组间休息，完成后自动 LP。末组为带反馈留出评估，不是独立验证。</p>
      <p className="muted">每次只亮一条黄色边：哪边亮，就朝哪边进行眼动辅助 SMR。「光标反馈」在 6 秒保持后显示一次预测；「持续光标控制」在 {CONTROL_TARGET_SEC} 秒内用蓝环碰到亮边，其他边不计分。</p>
      <p className="muted">持续控制共 {model?.activeClasses?.length === 2 ? 20 : 16} 轮，每轮中央准备 3 秒、亮边 {CONTROL_TARGET_SEC} 秒、结果 1.5 秒。移动速度已调至原来的 3 倍。命中后保持至本轮结束，再回中开始下一轮。蓝环由 REVE＋LP 的实时概率驱动；可点「回中准备」重试当前目标。</p>
      {notice ? <p role="status">{notice}</p> : null}
      <div ref={arena} className="gaze-arena" aria-label="全屏注视任务">
        <div ref={field} className="gaze-field">
        {(mode === 'control' || mode === 'train') && (phase === 'control' || phase === 'feedback') ? <>
          <div className={`gaze-edge is-${trial?.target}${hit ? ' is-hit' : ''}`} role="img" aria-label={`目标边：${trial ? DIRECTION_NAMES[trial.target] : ''}`} />
          <div className="gaze-cursor gaze-moving-cursor" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} role="img" aria-label="持续控制光标" />
          <p className="gaze-instruction" role="status">{hit ? '命中！保持，等待下一轮' : phase === 'feedback' ? '本轮未命中，准备下一轮' : feedbackError || (trial ? `${MI[trial.target]}，将蓝环移到亮边` : '')}</p>
          <p className="gaze-legend">第 {(trial?.index ?? 0) + 1}/{totalTrials} 轮 · 命中 {hits} · 仅亮边有效</p>
          {phase === 'control' && !hit ? <button className="btn gaze-recenter" onClick={recenter}>回中准备</button> : null}
        </> : ['baseline', 'target', 'feedback'].includes(phase) ? (
          <>
            {phase === 'baseline' ? <div className="gaze-dot is-center" /> : <div className={`gaze-edge is-${trial?.target}`} role="img" aria-label={`目标边：${trial ? DIRECTION_NAMES[trial.target] : ''}`} />}
            {mode === 'feedback' && (phase !== 'feedback' || prediction) ? <div
              className={`gaze-cursor is-${phase === 'feedback' ? prediction : 'center'}`}
              role="img" aria-label={phase === 'feedback' && prediction ? `预测光标：${DIRECTION_NAMES[prediction]}` : '预测光标：等待本次注视完成'}
            /> : null}
            <p className="gaze-instruction" role="status">{phase === 'baseline' ? '注视中央' : phase === 'feedback'
              ? prediction ? `预测：${DIRECTION_NAMES[prediction]} · 标靶：${trial ? DIRECTION_NAMES[trial.target] : ''}` : `本次无有效预测：${feedbackError}`
              : mode === 'feedback' ? `${trial ? MI[trial.target] : ''}，完成后显示预测光标` : trial ? MI[trial.target] : ''}</p>
            {mode === 'feedback' ? <p className="gaze-legend">黄色亮边：目标 · 蓝色圆环：预测光标</p> : null}
            <span className="gaze-progress">{mode === 'control' ? '持续控制 · 注视中央，正在准备' : <>{mode === 'preview' ? '预览 · ' : mode === 'feedback' ? '光标反馈 · ' : ''}第 {trial?.run} 组 · {(trial?.index ?? 0) + 1}/{totalTrials}</>}</span>
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
      </div>
      <p>有效试次 {accepted} · 剔除 {rejected}。标签表示要求的注视方向，不代表眼动仪测得的实际注视点。</p>
      {report ? <section className="gaze-results">
        <h2>{mode === 'feedback' ? '光标反馈结果（非独立验证）' : mode === 'validate' ? '独立验证' : '第三组留出评估（采集时有实时反馈）'}</h2>
        <p>均衡准确率：{report.balancedAccuracy === null ? '方向不全，无法评估' : `${(report.balancedAccuracy * 100).toFixed(1)}%`} · 有效试次 {report.n} · 机会水平 {model?.activeClasses?.length === 2 ? '50%' : '25%'}</p>
        <ul>{(model?.activeClasses?.length === 2 ? DIRECTIONS.slice(0,2) : DIRECTIONS).map((dir, i) => <li key={dir}>{DIRECTION_NAMES[dir]}：召回率 {report.recalls[i] === null ? '无样本' : `${(report.recalls[i]! * 100).toFixed(0)}%`}</li>)}</ul>
      </section> : null}
      <div className="gaze-controls">
        <button className="btn" disabled={running || !model} onClick={downloadModel}>导出 REVE 训练报告</button>
        <button className="btn" disabled={running} onClick={() => logger.current.download('json')}>导出本轮事件</button>
        <Link className="btn" to="/recordings">查看 EEG 会话</Link>
      </div>
      <p className="muted">当前 REVE＋LP 模型：{model ? `${model.subjectId} · ${model.channels.length} 通道 · ${model.trials} 个训练试次` : '尚未训练'}。{model?.bootstrapGazeOnly ? ' 当前为旧纯眼动数据初始化，尚未用联合任务数据训练。' : ''}</p>
      {model ? <p className="muted">头版本：{model.modelRevision} · 训练时留出均衡准确率：{model.evaluation.balancedAccuracy === null ? '不可评估' : `${(model.evaluation.balancedAccuracy * 100).toFixed(1)}%`}（{model.evaluation.n} 次）。</p> : null}
    </main>
  )
}
