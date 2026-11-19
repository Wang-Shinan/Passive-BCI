import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { sampleClock } from '../../lib/eeg/sampleClock'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { SessionLogger } from '../../lib/logger'
import { randomSeed } from '../../lib/rng'
import { canStartExperimentRecording, recorderIsActive, stopExperimentRecording } from '../../lib/session/recordControl'
import { attachJawRecording } from './recording'
import { sessionHub } from '../../lib/session/sessionHub'
import { acqRuntime } from '../../acquisition/runtime'
import { requestGuiRecovery } from '../../acquisition/omni/guiSession'
import type { GuiTriggerResult } from '../../acquisition/omni/guiTrigger'
import { CuedRecovery } from '../cuedRecovery'
import { ExportButtons, loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { createJawPlan, DEFAULT_JAW_CONFIG, JAW_CLASSES, jawInterval, jawPhaseDuration, type JawConfig, type JawLabel, type JawPhase } from './protocol'
import '../smr-acquisition/acquisitionView.css'
import './jawClench.css'

type Active = {
  config: JawConfig; plan: JawLabel[]; index: number; phase: JawPhase; started: number; lastTick: number
  preview: boolean; hz: number; channels: string[]; device: string | null; lastSample: number
  sampleStart: number | null; collectStarted: number | null; invalid: string | null
  runId: string; requireMarker: boolean; recorded: boolean; awaitingRecovery: boolean
  onset: Promise<GuiTriggerResult | null> | null
}
type View = 'idle' | 'starting' | JawPhase | 'waiting' | 'saving' | 'done' | 'stopped'

export function JawClenchPage() {
  const eeg = useLiveEeg()
  const [subject, setSubject] = useState(() => loadStoredSubjectId('S01'))
  const [config, setConfig] = useState<JawConfig>({ ...DEFAULT_JAW_CONFIG })
  const [phase, setPhase] = useState<View>('idle')
  const [target, setTarget] = useState<JawLabel>('relax')
  const [index, setIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const [flagged, setFlagged] = useState(false)
  const [preview, setPreview] = useState(false)
  const [counts, setCounts] = useState({ valid: 0, invalid: 0 })
  const countsRef = useRef({ valid: 0, invalid: 0 })
  const surface = useRef<HTMLElement>(null)
  const settings = useRef<HTMLDialogElement>(null)
  const logger = useRef(new SessionLogger('jaw-clench', subject))
  const active = useRef<Active | null>(null)
  const ownsRecording = useRef(false)
  const attachedRecording = useRef(false)
  const busy = useRef(false)
  const starting = useRef(false)
  const pendingFin = useRef(new Set<Promise<void>>())
  const generation = useRef(0)
  const recovery = useRef(new CuedRecovery({
    hasActiveRun: () => !!active.current && !active.current.preview && active.current.requireMarker,
    inInterruptiblePhase: () => active.current?.phase !== 'recovery',
    nextTrialIndex: () => (active.current?.index ?? -1) + 1,
    planLength: () => active.current?.plan.length ?? 0,
    readyToResume: () => canStartExperimentRecording() && !!sampleClock.snapshot(),
    ownsReopen: () => ownsRecording.current,
    onInterrupt: async (event) => {
      const state = active.current
      if (!state) return
      log('acquisition_interrupted', {
        reason: event.reason, detail: event.detail, runId: state.runId,
        upstreamSessionId: event.context?.sessionId ?? null,
        generation: event.context?.generation ?? null,
        segmentId: event.context?.segmentId ?? null,
      })
      await Promise.allSettled([...pendingFin.current])
    },
    invalidateCurrent: async () => {
      const state = active.current
      if (!state) return
      if (state.phase === 'recovery' || state.recorded) return
      state.invalid = 'acquisition_interrupted'
      await recordTrial(state, performance.now())
      log('jaw_invalid', { trialIndex: state.index, reason: state.invalid })
      setPhase('waiting')
    },
    resumeNext: (next) => {
      const state = active.current
      if (!state) return
      log('acquisition_resumed', { runId: state.runId, nextTrialIndex: next, previousInvalidTrial: next - 1 })
      state.index = next
      state.invalid = null
      state.recorded = false
      state.onset = null
      state.awaitingRecovery = false
      state.sampleStart = null
      state.collectStarted = null
      state.lastSample = sampleClock.snapshot()?.sampleIndex ?? 0
      setFlagged(false)
      enter(state, 'prepare', performance.now())
    },
    completeRun: () => { void finish() },
    onStopped: (reason) => { void finish(`EEG 中断：${reason}`) },
    onWaitingChange: (waiting) => { if (waiting) setPhase('waiting') },
  })).current
  const running = ['prepare', 'cue', 'collect', 'recovery', 'waiting'].includes(phase)
  const locked = running || phase === 'starting' || phase === 'saving'
  const live = eeg.live && eeg.meta.device !== 'demo'

  const log = (type: string, data: Record<string, unknown>) => {
    // Preview must not append annotations to an unrelated active recording.
    return attachedRecording.current ? logger.current.log(type, data) : null
  }
  const stopOwnedRecording = async () => {
    if (!ownsRecording.current) return null
    ownsRecording.current = false
    if (!recorderIsActive()) return null
    const result = await stopExperimentRecording()
    if (!result.ok || !result.rel) throw new Error(result.message || '未确认录制保存')
    return result
  }
  const sampleAt = (now: number) => {
    const value = sampleClock.sampleIndexAt(now)
    return value === null ? null : Math.round(value)
  }
  const markerInfo = (marker: GuiTriggerResult | null) => marker ? {
    outcome: marker.outcome,
    upstreamSessionId: marker.context?.upstreamSessionId ?? null,
    generation: marker.context?.generation ?? null,
    segmentId: marker.context?.segmentId ?? null,
    sequence: marker.ack?.sequence ?? null,
    sample_index: marker.ack?.sample_index ?? null,
    host_time: marker.ack?.host_time ?? null,
    error: marker.error ?? null,
  } : null
  const recordTrial = (state: Active, now: number, reason = state.invalid): Promise<void> => {
    if (state.recorded) return Promise.resolve()
    state.recorded = true
    const snap = {
      index: state.index,
      label: state.plan[state.index]!,
      onset: state.onset,
      requireMarker: state.requireMarker,
      sampleStart: state.sampleStart,
      collectStarted: state.collectStarted,
      hz: state.hz,
      collectSec: state.config.collectSec,
      preview: state.preview,
      runId: state.runId,
      invalid: reason,
      endPerfMs: now,
      endSample: sampleAt(now),
      recordingId: sessionHub.info.id,
      attached: attachedRecording.current,
    }
    const task = (async () => {
      const marker = snap.onset ? await snap.onset.catch(() => null) : null
      const markerReason = snap.requireMarker
        ? (marker?.outcome === 'acked' ? null : `gui_onset_${marker?.outcome ?? 'missing'}`)
        : null
      const interval = jawInterval(snap.sampleStart, snap.endSample, snap.hz, snap.collectSec, snap.invalid ?? markerReason, snap.preview)
      const data = { trialIndex: snap.index, label: snap.label, classId: JAW_CLASSES[snap.label],
        labelSource: 'instruction', observedClench: null, collectStartPerfMs: snap.collectStarted, collectEndPerfMs: snap.endPerfMs,
        runId: snap.runId, guiOnset: markerInfo(marker), ...interval }
      if (snap.attached) {
        if (snap.recordingId) logger.current.logTo(snap.recordingId, 'jaw_trial', data)
        else logger.current.log('jaw_trial', data)
      }
      if (!snap.preview) {
        countsRef.current[interval.valid ? 'valid' : 'invalid'] += 1
        setCounts({ ...countsRef.current })
      }
    })()
    pendingFin.current.add(task)
    void task.finally(() => pendingFin.current.delete(task))
    if (snap.recordingId) sessionHub.defer(snap.recordingId, task)
    return task
  }
  const enter = (state: Active, next: JawPhase, now: number) => {
    state.phase = next; state.started = now; state.lastTick = now
    if (next === 'collect') { state.sampleStart = sampleAt(now); state.collectStarted = now }
    setPhase(next); setIndex(state.index); setTarget(state.plan[state.index]!)
    const marker = log('jaw_phase', { trialIndex: state.index, phase: next, instructedLabel: state.plan[state.index],
      durationSec: jawPhaseDuration(state.config, next), onsetPerfMs: now, sampleIndexEstimate: sampleAt(now) })
    if (next === 'collect') state.onset = marker ?? null
  }
  const finish = async (reason?: string) => {
    const cancelled = recovery.cancel()
    generation.current += 1
    const state = active.current
    if (!state && !starting.current) return
    active.current = null
    if (state) {
      if (reason && state.phase !== 'recovery') await recordTrial(state, performance.now(), reason)
      await Promise.allSettled([...pendingFin.current])
      log(reason ? 'session_abort' : 'session_end', { reason: reason ?? null, complete: !reason, runId: state.runId, ...countsRef.current })
    }
    busy.current = true; setPhase('saving')
    const wasAttached = attachedRecording.current
    attachedRecording.current = false
    try {
      await cancelled
      const saved = await stopOwnedRecording()
      if (wasAttached && !saved) await sessionHub.flush()
      setNotice(reason
        ? `采集已中断：${reason}。${saved?.message ?? ''}`
        : saved?.message ?? (wasAttached ? '采集完成，标签已写入当前录制；请在采集页保存该录制。' : '预览完成，未录制 EEG。'))
      setPhase(reason ? 'stopped' : 'done')
    } catch (error) { setNotice(`保存未完成：${String(error)}`); setPhase('stopped') }
    finally { if (!starting.current) busy.current = false }
  }
  const start = async (demo: boolean) => {
    if (busy.current || active.current) return
    const guiLink = !demo && acqRuntime.device === 'omni' && acqRuntime.omniLink === 'gui'
    try {
      createJawPlan(config, 0)
      if (!subject.trim()) throw new Error('请填写被试编号')
      if (!demo && !canStartExperimentRecording()) throw new Error('请先在采集页连接真实 EEG 并开始采集')
      if (recorderIsActive() && !guiLink) throw new Error('已有录制正在进行，请先在采集页保存并结束当前录制')
    } catch (error) { setNotice(String(error)); settings.current?.showModal(); return }
    busy.current = true; starting.current = true
    const token = ++generation.current
    setPhase('starting'); setPreview(demo); setNotice(''); setFlagged(false)
    ownsRecording.current = false; attachedRecording.current = false
    countsRef.current = { valid: 0, invalid: 0 }; setCounts({ ...countsRef.current })
    logger.current = new SessionLogger('jaw-clench', subject.trim())
    const seed = randomSeed()
    try {
      if (!surface.current?.requestFullscreen) throw new Error('请使用支持全屏的桌面浏览器')
      await surface.current.requestFullscreen()
      if (token !== generation.current) return
      if (!demo) {
        const result = await attachJawRecording(subject.trim(), seed, guiLink)
        ownsRecording.current = result.owns
        attachedRecording.current = result.attached
        if (token !== generation.current) {
          log('session_abort', { reason: '开始期间取消', complete: false })
          await stopOwnedRecording(); return
        }
        if (!result.ok || !result.attached) throw new Error(`${result.message}；需要本地落盘以保存 EEG 和标签`)
      }
      const meta = liveEegHub.meta
      if (!demo && (!canStartExperimentRecording() || !sampleClock.snapshot())) throw new Error('EEG 未就绪')
      const now = performance.now()
      const runId = crypto.randomUUID()
      const state: Active = { config: { ...config }, plan: createJawPlan(config, seed), index: 0, phase: 'prepare',
        started: now, lastTick: now, preview: demo, hz: meta.sampleRate, channels: [...meta.channelNames], device: meta.device,
        lastSample: sampleClock.snapshot()?.sampleIndex ?? 0, sampleStart: null, collectStarted: null, invalid: null,
        runId, requireMarker: guiLink, recorded: false, awaitingRecovery: false, onset: null }
      recovery.arm()
      active.current = state
      if (!demo) sessionHub.bindMeta({ runId })
      log('session_start', { protocol: 'jaw-clench-cued-v1', seed, plan: state.plan, config: state.config,
        classMap: JAW_CLASSES, labelSource: 'instruction', observedClench: null, sampleRate: state.hz,
        channels: state.channels, device: state.device, sampleIndexScope: 'stream', runId,
        instructions: { clench: '轻轻咬合，保持', relax: '牙齿自然分开，放松' } })
      enter(state, 'prepare', now)
    } catch (error) {
      log('session_abort', { reason: String(error), complete: false })
      try { await stopOwnedRecording() } catch (saveError) { setNotice(String(saveError)) }
      setNotice(String(error)); setPhase('stopped')
    } finally { starting.current = false; busy.current = false }
  }

  const markInvalid = useEffectEvent(() => {
    const state = active.current
    if (!state || state.phase === 'recovery') return
    state.invalid = 'operator_marked_invalid'; setFlagged(true)
    log('jaw_invalid', { trialIndex: state.index, reason: state.invalid })
  })
  const tick = useEffectEvent(() => {
    const state = active.current
    if (!state) return
    const now = performance.now()
    if (recovery.waiting) { state.lastTick = now; recovery.maybeResume(); return }
    if (now - state.lastTick > 500) { void finish('页面计时中断'); return }
    state.lastTick = now
    if (!state.preview) {
      const meta = liveEegHub.meta
      const sample = sampleClock.snapshot()?.sampleIndex ?? 0
      if (!recorderIsActive() || !liveEegHub.isFresh() || now - meta.lastAt > 1000) {
        if (state.requireMarker && !state.awaitingRecovery && recorderIsActive() && requestGuiRecovery('source_idle')) {
          state.awaitingRecovery = true
          return
        }
        void finish('EEG 或录制中断'); return
      }
      if (sample < state.lastSample || meta.device !== state.device || meta.sampleRate !== state.hz || meta.channelNames.join('|') !== state.channels.join('|')) {
        void finish('设备、采样时钟或通道配置改变'); return
      }
      state.lastSample = sample
    }
    if (now - state.started < jawPhaseDuration(state.config, state.phase) * 1000) return
    if (state.phase === 'prepare') enter(state, 'cue', now)
    else if (state.phase === 'cue') enter(state, 'collect', now)
    else if (state.phase === 'collect') { recordTrial(state, now); enter(state, 'recovery', now) }
    else {
      state.index += 1
      if (state.index >= state.plan.length) { void finish(); return }
      state.invalid = null; state.recorded = false; state.onset = null; state.awaitingRecovery = false
      state.sampleStart = null; state.collectStarted = null; setFlagged(false)
      enter(state, 'prepare', now)
    }
  })
  const interrupt = useEffectEvent((reason: string) => { if (active.current || starting.current) void finish(reason) })
  useEffect(() => {
    recovery.attach()
    const timer = window.setInterval(tick, 50)
    const full = () => { if (!document.fullscreenElement) interrupt('退出全屏') }
    const hidden = () => { if (document.hidden) interrupt('页面隐藏') }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') interrupt('手动停止')
      if (event.code === 'KeyX' && !event.repeat) markInvalid()
    }
    const unload = (event: BeforeUnloadEvent) => { if (active.current || busy.current) { event.preventDefault(); event.returnValue = '' } }
    document.addEventListener('fullscreenchange', full); document.addEventListener('visibilitychange', hidden)
    window.addEventListener('keydown', key); window.addEventListener('beforeunload', unload)
    return () => {
      clearInterval(timer)
      recovery.detach()
      document.removeEventListener('fullscreenchange', full); document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('keydown', key); window.removeEventListener('beforeunload', unload)
      interrupt('离开页面')
    }
  }, [recovery])

  const activeCue = phase === 'cue' || phase === 'collect'
  return <main ref={surface} className="smr-participant jaw-participant" aria-label="咬牙与放松采集">
    <header className="smr-participant-header"><span>咬牙 / 放松</span>
      {!locked && <button className="smr-subtle-button" onClick={() => settings.current?.showModal()}>实验员设置</button>}
    </header>
    <div className="smr-participant-field">
      <div className="smr-participant-center">
        <div className={`jaw-cue-ring ${activeCue ? `is-${target}` : ''}`} aria-hidden="true" />
        <h1>{activeCue ? target === 'clench' ? '咬牙' : '放松' : phase === 'prepare' ? '准备' : phase === 'recovery' ? '放松休息'
          : phase === 'waiting' ? 'EEG 中断' : phase === 'starting' ? '请稍候' : phase === 'saving' ? '正在保存' : phase === 'done' ? '本轮完成' : phase === 'stopped' ? '采集已停止' : '准备好了吗'}</h1>
        <p role="status">{phase === 'waiting' ? '正在恢复；当前试次已作废' : activeCue ? target === 'clench' ? '轻轻咬合，保持' : '牙齿自然分开，保持放松'
          : running ? '放松下颌，注视中央' : phase === 'done' ? '谢谢配合，可以休息了。'
            : phase === 'stopped' ? '请放松，等待实验员处理。' : locked ? '请放松，等待片刻。' : '跟随提示，完成咬牙和放松两种动作。'}</p>
        {!locked && <div className="jaw-start-actions">
          <button className="smr-participant-primary" disabled={!live} onClick={() => void start(false)}>全屏开始采集</button>
          <button className="smr-subtle-button" onClick={() => void start(true)}>预览流程（不录制）</button>
        </div>}
        {!locked && !live && <small className="smr-participant-preview">等待实验员连接 EEG</small>}
      </div>
      {running && <><span className="smr-participant-progress">{index + 1} / {config.trials}{preview ? ' · 预览' : ''}{flagged ? ' · 本次已标记' : ''}</span>
        <button className="smr-subtle-button smr-participant-stop" onClick={() => void finish('手动停止')}>停止 · Esc</button></>}
    </div>
    <footer className="smr-participant-footer">{!locked ? <Link to="/">返回实验目录</Link> : <span />}<span>按提示动作，自然呼吸</span></footer>
    <dialog ref={settings} className="smr-operator-dialog" aria-labelledby="jaw-settings-title">
      <div className="smr-operator-heading">
        <h2 id="jaw-settings-title">咬牙采集设置</h2>
        <nav className="smr-operator-navigation" aria-label="实验员页面导航">
            {!locked ? <Link to="/" className="smr-subtle-button">← 返回实验目录</Link>
              : <button type="button" className="smr-subtle-button" disabled title="请先结束当前采集或等待保存、训练完成">← 返回实验目录</button>}
          <button type="button" className="smr-subtle-button" onClick={() => settings.current?.close()}>返回被试画面</button>
        </nav>
      </div>
      <LiveEegBadge />
      <ExportButtons logger={logger.current} subjectId={subject} onSubjectChange={setSubject} experiment="jaw-clench" />
      <section className="smr-operator-section"><h3>采集计划</h3><fieldset className="smr-operator-fields" disabled={locked}>
        <label>总试次数（两类各半）<input type="number" min={2} max={200} step={2} value={config.trials} onChange={e => setConfig({ ...config, trials: Number(e.target.value) })} /></label>
        {([['prepareSec', '准备时间'], ['cueSec', '动作缓冲'], ['collectSec', '有效采集'], ['recoverySec', '恢复休息']] as const).map(([name, title]) =>
          <label key={name}>{title}（秒）<input type="number" min={1} max={10} step={.5} value={config[name]} onChange={e => setConfig({ ...config, [name]: Number(e.target.value) })} /></label>)}
      </fieldset>
        <p className="smr-operator-status">两类等量随机；准备 → 提示动作并缓冲 → 有效采集 → 放松休息。仅有效采集阶段生成二分类片段，准备和恢复不自动标成负样本。</p>
        <p className="smr-operator-status">标签 0＝放松，1＝咬牙，来源是任务指令，未确认实际动作。未按提示完成时，实验员按 X 标记当前试次无效（有效采集结束前）。断流、退出全屏或页面隐藏会中止采集。此入口仅采集，不启动模型或训练。</p>
      </section>
      <section className="smr-operator-section"><h3>记录状态</h3><p className="smr-operator-status" role="status">{notice || '等待开始'}</p>
        <p className="smr-operator-status">有效片段 {counts.valid} · 无效片段 {counts.invalid}。原始 EEG 与 jaw_phase / jaw_trial 事件保存在会话库。</p>
      </section>
    </dialog>
  </main>
}
