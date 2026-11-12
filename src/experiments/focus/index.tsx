import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { sampleClock } from '../../lib/eeg/sampleClock'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { softScore, useFeatureMonitor } from '../../lib/features'
import { SessionLogger } from '../../lib/logger'
import { randomSeed } from '../../lib/rng'
import { canStartExperimentRecording, recorderIsActive, stopExperimentRecording } from '../../lib/session/recordControl'
import { attachFocusRecording } from './recording'
import { ExportButtons, loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { createFocusPlan, DEFAULT_FOCUS_CONFIG, FOCUS_CLASSES, focusInterval, focusPhaseDuration, resolveFocusChannels, type FocusConfig, type FocusLabel, type FocusPhase } from './protocol'
import '../smr-acquisition/acquisitionView.css'
import './focus.css'

type Active = {
  config: FocusConfig; plan: FocusLabel[]; index: number; phase: FocusPhase; started: number; lastTick: number
  preview: boolean; hz: number; channels: string[]; device: string | null; lastSample: number
  sampleStart: number | null; collectStarted: number | null; invalid: string | null
}
type View = 'idle' | 'starting' | FocusPhase | 'saving' | 'done' | 'stopped'

export function FocusAcquisitionPage() {
  const eeg = useLiveEeg()
  const [subject, setSubject] = useState(() => loadStoredSubjectId('S01'))
  const [config, setConfig] = useState<FocusConfig>({ ...DEFAULT_FOCUS_CONFIG })
  const [phase, setPhase] = useState<View>('idle')
  const [target, setTarget] = useState<FocusLabel>('relax')
  const [index, setIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const [flagged, setFlagged] = useState(false)
  const [preview, setPreview] = useState(false)
  const [counts, setCounts] = useState({ valid: 0, invalid: 0 })
  const countsRef = useRef({ valid: 0, invalid: 0 })
  const surface = useRef<HTMLElement>(null)
  const settings = useRef<HTMLDialogElement>(null)
  const logger = useRef(new SessionLogger('focus', subject))
  const active = useRef<Active | null>(null)
  const attachedRecording = useRef(false)
  const ownsRecording = useRef(false)
  const busy = useRef(false)
  const starting = useRef(false)
  const generation = useRef(0)
  const running = ['prepare', 'cue', 'collect', 'recovery'].includes(phase)
  const locked = running || phase === 'starting' || phase === 'saving'
  const live = eeg.live && eeg.meta.device !== 'demo'
  // Live focus feedback: real EEG in sessions, synthesized EEG in preview so the
  // visual effect is visible before a session starts. A channel subset restricts
  // which channels contribute to focus_score; raw recording is unaffected.
  const [channelText, setChannelText] = useState('CH1 CH9 CH16 CH7 CH8 CH10')
  const channelSel = useMemo(() => {
    const sel = resolveFocusChannels(channelText, eeg.meta.channelNames)
    if (!sel.mask) return { ...sel, blocked: [] as number[] }
    const blocked = sel.matched.filter(i => liveEegHub.isBad(eeg.meta.channelNames[i]))
    if (!blocked.length) return { ...sel, blocked }
    const mask = sel.mask.map((v, i) => v && !liveEegHub.isBad(eeg.meta.channelNames[i]))
    return { ...sel, mask: mask.some(Boolean) ? mask : null, matched: sel.matched.filter(i => !blocked.includes(i)), blocked }
  }, [channelText, eeg.meta.channelNames])
  const features = useFeatureMonitor({ preferLive: !preview, ensureFeatures: ['focus_score'], channelMask: channelSel.mask })
  const [focusLevel, setFocusLevel] = useState(0)
  const smoothRef = useRef(0)
  const focusTrail = useRef<{ raw: number }[]>([])

  const log = (type: string, data: Record<string, unknown>) => {
    // Attached includes a reused active recording; preview never attaches, so it
    // cannot append annotations to an unrelated recording.
    if (attachedRecording.current) logger.current.log(type, data)
  }
  const stopOwnedRecording = async () => {
    if (!ownsRecording.current) return null
    ownsRecording.current = false
    const result = await stopExperimentRecording()
    if (!result.ok || !result.rel) throw new Error(result.message || '未确认录制保存')
    return result
  }
  const sampleAt = (now: number) => {
    const value = sampleClock.sampleIndexAt(now)
    return value === null ? null : Math.round(value)
  }
  const recordTrial = (state: Active, now: number, reason = state.invalid) => {
    const interval = focusInterval(state.sampleStart, sampleAt(now), state.hz, state.config.collectSec, reason, state.preview)
    const scored = focusTrail.current.map(item => item.raw)
    const measured = scored.length
      ? { n: scored.length, mean: scored.reduce((a, b) => a + b, 0) / scored.length, last: scored[scored.length - 1], max: Math.max(...scored) }
      : null
    log('focus_trial', { trialIndex: state.index, label: state.plan[state.index], classId: FOCUS_CLASSES[state.plan[state.index]!],
      labelSource: 'instruction', measuredFocusScore: measured, collectStartPerfMs: state.collectStarted, collectEndPerfMs: now, ...interval })
    if (!state.preview) {
      countsRef.current[interval.valid ? 'valid' : 'invalid'] += 1
      setCounts({ ...countsRef.current })
    }
  }
  const enter = (state: Active, next: FocusPhase, now: number) => {
    state.phase = next; state.started = now; state.lastTick = now
    if (next === 'collect') { state.sampleStart = sampleAt(now); state.collectStarted = now; focusTrail.current = [] }
    setPhase(next); setIndex(state.index); setTarget(state.plan[state.index]!)
    log('focus_phase', { trialIndex: state.index, phase: next, instructedLabel: state.plan[state.index],
      durationSec: focusPhaseDuration(state.config, next), onsetPerfMs: now, sampleIndexEstimate: sampleAt(now) })
  }
  const finish = async (reason?: string) => {
    generation.current += 1
    const state = active.current
    if (!state && !starting.current) return
    active.current = null
    if (state) {
      if (reason && state.phase !== 'recovery') recordTrial(state, performance.now(), reason)
      log(reason ? 'session_abort' : 'session_end', { reason: reason ?? null, complete: !reason, ...countsRef.current })
    }
    busy.current = true; setPhase('saving')
    const wasAttached = attachedRecording.current
    attachedRecording.current = false
    try {
      const saved = await stopOwnedRecording()
      setNotice(reason
        ? `采集已中断：${reason}。${saved?.message ?? (wasAttached ? '标签已写入当前录制，录制仍在进行。' : '')}`
        : saved?.message ?? (wasAttached ? '采集完成，标签已写入当前录制；请在采集页保存该录制。' : '预览完成，未录制 EEG。'))
      setPhase(reason ? 'stopped' : 'done')
    } catch (error) { setNotice(`保存未完成：${String(error)}`); setPhase('stopped') }
    finally { if (!starting.current) busy.current = false }
  }
  const start = async (demo: boolean) => {
    if (busy.current || active.current) return
    try {
      createFocusPlan(config, 0)
      if (!subject.trim()) throw new Error('请填写被试编号')
      if (!demo && !canStartExperimentRecording()) throw new Error('请先在采集页连接真实 EEG 并开始采集')
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return }
    busy.current = true; starting.current = true
    const token = ++generation.current
    setPhase('starting'); setPreview(demo); setNotice(''); setFlagged(false)
    countsRef.current = { valid: 0, invalid: 0 }; setCounts({ ...countsRef.current })
    logger.current = new SessionLogger('focus', subject.trim())
    const seed = randomSeed()
    try {
      settings.current?.close()
      if (!surface.current?.requestFullscreen) throw new Error('请使用支持全屏的桌面浏览器')
      await surface.current.requestFullscreen()
      if (token !== generation.current) return
      if (!demo) {
        const result = await attachFocusRecording(subject.trim(), seed)
        attachedRecording.current = result.attached
        ownsRecording.current = result.owns
        if (token !== generation.current) {
          log('session_abort', { reason: '开始期间取消', complete: false })
          attachedRecording.current = false
          await stopOwnedRecording(); return
        }
        if (!result.ok || !result.attached) throw new Error(`${result.message}；需要本地落盘以保存 EEG 和标签`)
      }
      const meta = liveEegHub.meta
      if (!demo && (!canStartExperimentRecording() || !sampleClock.snapshot())) throw new Error('EEG 未就绪')
      const now = performance.now()
      const state: Active = { config: { ...config }, plan: createFocusPlan(config, seed), index: 0, phase: 'prepare',
        started: now, lastTick: now, preview: demo, hz: meta.sampleRate, channels: [...meta.channelNames], device: meta.device,
        lastSample: sampleClock.snapshot()?.sampleIndex ?? 0, sampleStart: null, collectStarted: null, invalid: null }
      active.current = state
      log('session_start', { protocol: 'focus-cued-v1', seed, plan: state.plan, config: state.config,
        classMap: FOCUS_CLASSES, labelSource: 'instruction', measuredFeature: 'focus_score', sampleRate: state.hz,
        channels: state.channels, device: state.device, sampleIndexScope: 'stream',
        instructions: { focus: '盯住中央圆点，全神贯注', relax: '让思绪自然放空，保持放松' } })
      enter(state, 'prepare', now)
    } catch (error) {
      log('session_abort', { reason: String(error), complete: false })
      attachedRecording.current = false
      try { await stopOwnedRecording() } catch (saveError) { setNotice(String(saveError)) }
      setNotice(error instanceof Error ? error.message : String(error)); setPhase('stopped')
    } finally { starting.current = false; busy.current = false }
  }

  const markInvalid = useEffectEvent(() => {
    const state = active.current
    if (!state || state.phase === 'recovery') return
    state.invalid = 'operator_marked_invalid'; setFlagged(true)
    log('focus_invalid', { trialIndex: state.index, reason: state.invalid })
  })
  const tick = useEffectEvent(() => {
    const state = active.current
    if (!state) return
    const now = performance.now()
    if (now - state.lastTick > 500) { void finish('页面计时中断'); return }
    state.lastTick = now
    if (!state.preview) {
      const meta = liveEegHub.meta
      const sample = sampleClock.snapshot()?.sampleIndex ?? 0
      if (!recorderIsActive() || !liveEegHub.isFresh() || now - meta.lastAt > 1000) { void finish('EEG 或录制中断'); return }
      if (sample < state.lastSample || meta.device !== state.device || meta.sampleRate !== state.hz || meta.channelNames.join('|') !== state.channels.join('|')) {
        void finish('设备、采样时钟或通道配置改变'); return
      }
      state.lastSample = sample
    }
    if (now - state.started < focusPhaseDuration(state.config, state.phase) * 1000) return
    if (state.phase === 'prepare') enter(state, 'cue', now)
    else if (state.phase === 'cue') enter(state, 'collect', now)
    else if (state.phase === 'collect') { recordTrial(state, now); enter(state, 'recovery', now) }
    else {
      state.index += 1
      if (state.index >= state.plan.length) { void finish(); return }
      state.invalid = null; state.sampleStart = null; state.collectStarted = null; setFlagged(false)
      enter(state, 'prepare', now)
    }
  })
  const interrupt = useEffectEvent((reason: string) => { if (active.current || starting.current) void finish(reason) })
  useEffect(() => {
    const raw = features.latest?.values.focus_score
    if (raw === undefined || !Number.isFinite(raw)) return
    smoothRef.current = smoothRef.current * 0.75 + softScore(raw) * 0.25
    setFocusLevel(Math.round(smoothRef.current * 10) / 10)
    const state = active.current
    if (state?.phase === 'collect' && state.collectStarted !== null) focusTrail.current.push({ raw })
  }, [features.latest])
  useEffect(() => {
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
      document.removeEventListener('fullscreenchange', full); document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('keydown', key); window.removeEventListener('beforeunload', unload)
      interrupt('离开页面')
    }
  }, [])

  const activeCue = phase === 'cue' || phase === 'collect'
  return <main ref={surface} className="smr-participant focus-participant" aria-label="专注与放松采集">
    <header className="smr-participant-header"><span>放松 / 专注</span>
      {!locked && <button className="smr-subtle-button" onClick={() => settings.current?.showModal()}>实验员设置</button>}
    </header>
    <div className="smr-participant-field">
      <div className="smr-participant-center">
        <div className="focus-cue-wrap">
          {features.latest && <div className="focus-aura" style={{
            transform: `scale(${0.55 + (focusLevel / 100) * 1.2})`,
            opacity: 0.1 + (focusLevel / 100) * 0.55,
          }} aria-hidden="true" />}
          <div className={`focus-cue-ring ${activeCue ? `is-${target}` : ''}`} aria-hidden="true" />
        </div>
        <h1>{activeCue ? target === 'focus' ? '专注' : '放松' : phase === 'prepare' ? '准备' : phase === 'recovery' ? '放松休息'
          : phase === 'starting' ? '请稍候' : phase === 'saving' ? '正在保存' : phase === 'done' ? '本轮完成' : phase === 'stopped' ? '采集已停止' : '准备好了吗'}</h1>
        <p role="status">{activeCue ? target === 'focus' ? '盯住中央圆点，全神贯注' : '让思绪自然放空，保持放松'
          : running ? '放松身心，注视中央' : phase === 'done' ? '谢谢配合，可以休息了。'
            : phase === 'stopped' ? '请放松，等待实验员处理。' : locked ? '请放松，等待片刻。' : '跟随提示，完成专注和放松两种状态。'}</p>
        {!locked && <div className="focus-start-actions">
          <button className="smr-participant-primary" disabled={!live} onClick={() => void start(false)}>全屏开始采集</button>
          <button className="smr-subtle-button" onClick={() => void start(true)}>预览流程（不录制）</button>
        </div>}
        {!locked && notice && <p role="alert" className="smr-participant-preview">{notice}</p>}
        {!locked && !live && <small className="smr-participant-preview">等待实验员连接 EEG</small>}
      </div>
      {running && <><span className="smr-participant-progress">{index + 1} / {config.trials}{preview ? ' · 预览' : ''}{flagged ? ' · 本次已标记' : ''}</span>
        <button className="smr-subtle-button smr-participant-stop" onClick={() => void finish('手动停止')}>停止 · Esc</button></>}
    </div>
    <footer className="smr-participant-footer">{!locked ? <Link to="/">返回实验目录</Link> : <span />}<span>按提示调整状态，自然呼吸</span></footer>
    <dialog ref={settings} className="smr-operator-dialog" aria-labelledby="focus-settings-title">
      <div className="smr-operator-heading">
        <h2 id="focus-settings-title">专注采集设置</h2>
        <nav className="smr-operator-navigation" aria-label="实验员页面导航">
            {!locked ? <Link to="/" className="smr-subtle-button">← 返回实验目录</Link>
              : <button type="button" className="smr-subtle-button" disabled title="请先结束当前采集或等待保存、训练完成">← 返回实验目录</button>}
          <button type="button" className="smr-subtle-button" onClick={() => settings.current?.close()}>返回被试画面</button>
        </nav>
      </div>
      <LiveEegBadge />
      <ExportButtons logger={logger.current} subjectId={subject} onSubjectChange={setSubject} experiment="focus" />
      <section className="smr-operator-section"><h3>采集计划</h3><fieldset className="smr-operator-fields" disabled={locked}>
        <label>总试次数（两类各半）<input type="number" min={2} max={200} step={2} value={config.trials} onChange={e => setConfig({ ...config, trials: Number(e.target.value) })} /></label>
        {([['prepareSec', '准备时间'], ['cueSec', '状态缓冲'], ['collectSec', '有效采集'], ['recoverySec', '恢复休息']] as const).map(([name, title]) =>
          <label key={name}>{title}（秒）<input type="number" min={1} max={10} step={.5} value={config[name]} onChange={e => setConfig({ ...config, [name]: Number(e.target.value) })} /></label>)}
        <label>反馈特征通道（通道名或序号，空＝全部）<input type="text" value={channelText} onChange={e => setChannelText(e.target.value)} placeholder="CH1 CH9 CH16 CH7 CH8 CH10" /></label>
      </fieldset>
        <p className="smr-operator-status">{channelSel.mask
          ? `focus_score 只用 ${channelSel.matched.length} 个通道：${channelSel.matched.map(i => eeg.meta.channelNames[i] ?? `#${i + 1}`).join('、')}${channelSel.missing.length ? `；未匹配已忽略：${channelSel.missing.join('、')}` : ''}`
          : channelText.trim() ? '通道未匹配，focus_score 暂用全部通道。' : 'focus_score 使用全部通道。'}
          {channelSel.blocked.length ? ` ${channelSel.blocked.map(i => eeg.meta.channelNames[i] ?? `#${i + 1}`).join('、')} 已在采集页标记为坏道，不参与反馈。` : ''}
          通道子集只影响本页反馈光晕与试次实测统计，不影响原始 EEG 录制。</p>
        <p className="smr-operator-status">两类等量随机；准备 → 提示状态并缓冲 → 有效采集 → 放松休息。仅有效采集阶段生成二分类片段，准备和恢复不自动标成负样本。</p>
        <p className="smr-operator-status">标签 0＝放松，1＝专注，来源是任务指令，未测量实际专注度。未按提示完成时，实验员按 X 标记当前试次无效（有效采集结束前）。断流、退出全屏或页面隐藏会中止采集。此入口仅采集，不启动模型或训练。</p>
      </section>
      <section className="smr-operator-section"><h3>记录状态</h3><p className="smr-operator-status" role="status">{notice || '等待开始'}</p>
        <p className="smr-operator-status">有效片段 {counts.valid} · 无效片段 {counts.invalid}。原始 EEG 与 focus_phase / focus_trial 事件保存在会话库。</p>
        <p className="smr-operator-status">实时反馈 {features.latest ? `focus_score ${(features.latest.values.focus_score ?? NaN).toFixed(3)} → ${focusLevel.toFixed(0)} / 100` : '等待 EEG 特征'}。光晕大小与亮度随分数变化，只做动态反馈，不当作标签依据。</p>
      </section>
    </dialog>
  </main>
}
