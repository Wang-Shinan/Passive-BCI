import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { ModelServicePanel, modelRuntimeHub, modelServiceStatus, modelUrlPresets, useModelRuntime } from '../../lib/model-runtime'
import { connectGroupedSmrModel } from '../../lib/model-runtime/connectSmrModel'
import { randomSeed } from '../../lib/rng'
import { finalizeActiveRecording } from '../../lib/session/finalizeRecording'
import { loadStoredSubjectId, storeSubjectId } from '../../lib/ui/ExportButtons'
import { SmrAdaptPage } from '../smr-adapt'
import { loadProbeBaseline, waitForProbePrediction, type ProbeBaseline } from '../smr-adapt/groupedProbe'
import { smrModelAxes } from '../smr-adapt/labels'
import { useGroupedProbe } from '../smr-adapt/useGroupedProbe'
import { calibrationGroupSize, calibrationPlan, collectBlock, cueText, type CalibrationBlock, type Stimulus } from './calibration'
import { smrTrialSeconds } from './trialTiming'
import './acquisitionView.css'

const Practice = lazy(() => import('../armchair'))
type Stage = 'setup' | 'connecting' | 'practice' | 'collect' | 'rest' | 'paused' | 'cursor'
const maxGroups = 50

async function confirmModel(baseline: ProbeBaseline, signal: AbortSignal) {
  if (!liveEegHub.isFresh()) throw new Error('未收到实时 EEG，请先在采集页恢复开流。')
  if (modelRuntimeHub.snapshot.serviceHello?.model_revision !== baseline.revision) await loadProbeBaseline(baseline, signal)
  await waitForProbePrediction(baseline, signal)
  if (!liveEegHub.isFresh() || modelRuntimeHub.snapshot.serviceHello?.model_revision !== baseline.revision) {
    throw new Error('尚未确认本轮所用模型版本及其实时预测，请检查 EEG 和模型连接后重试。')
  }
}

export function SmrAcquisitionPage({ autoStartModel = true }: { autoStartModel?: boolean }) {
  const [params] = useSearchParams()
  if (params.get('mode') === 'grouped') return <SmrAdaptPage groupedAcquisition autoStartModel={autoStartModel} />
  return <GuidedAcquisition autoStartModel={autoStartModel} />
}

function GuidedAcquisition({ autoStartModel }: { autoStartModel: boolean }) {
  const surface = useRef<HTMLElement>(null)
  const settings = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false), active = useRef<AbortController | null>(null)
  const phase = useRef<Stage>('setup')
  const [stage, setStage] = useState<Stage>('setup')
  const [subject, setSubject] = useState(() => loadStoredSubjectId('S01'))
  const [rounds, setRounds] = useState(3), [preview, setPreview] = useState(false)
  const [minimumGain, setMinimumGain] = useState(0.02), [maximumRecallDrop, setMaximumRecallDrop] = useState(0)
  const [autoLora, setAutoLora] = useState(false), [loraEpochs, setLoraEpochs] = useState(5), [loraLr, setLoraLr] = useState(.0001)
  const [message, setMessage] = useState(''), [stimulus, setStimulus] = useState<Stimulus | null>(null)
  const [working, setWorking] = useState(false), [operatorOpen, setOperatorOpen] = useState(false)
  const [guidedCursor, setGuidedCursor] = useState<{ preview: boolean; seed: number; revision: string | null }>()
  const [cursorBusy, setCursorBusy] = useState(false)
  const plan = useRef<CalibrationBlock[]>([]), completed = useRef(0), seed = useRef(0)
  const probe = useGroupedProbe({ minimumGain, maximumRecallDrop,
    lora: autoLora ? { epochs: loraEpochs, lr: loraLr, rank: 4, alpha: 8, batchSize: 1, accumulationSteps: 8 } : undefined,
  }, true)
  const probeRef = useRef(probe)
  probeRef.current = probe
  const runtime = useModelRuntime()

  const show = useCallback((next: Stage) => {
    phase.current = next
    setStage(next)
  }, [])
  useEffect(() => {
    if (stage !== 'collect' || preview) return
    const timer = window.setInterval(() => {
      if (!liveEegHub.isFresh()) active.current?.abort(new Error('EEG 断流，已中断本组采集'))
    }, 250)
    return () => window.clearInterval(timer)
  }, [stage, preview])
  useEffect(() => {
    mounted.current = true
    const stopRecording = (reason: string) => {
      if (phase.current === 'connecting' || phase.current === 'collect') active.current?.abort(new Error(reason))
    }
    const hidden = () => { if (document.hidden) stopRecording('页面隐藏，当前操作已中断') }
    const fullscreen = () => { if (!document.fullscreenElement) stopRecording('退出全屏，当前操作已中断') }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (settings.current?.open) event.stopImmediatePropagation()
      else stopRecording('手动停止当前操作')
    }
    const guard = (event: BeforeUnloadEvent) => {
      if (active.current) { event.preventDefault(); event.returnValue = '' }
    }
    document.addEventListener('visibilitychange', hidden)
    document.addEventListener('fullscreenchange', fullscreen)
    window.addEventListener('keydown', key, true)
    window.addEventListener('beforeunload', guard)
    return () => {
      mounted.current = false
      active.current?.abort(new Error('离开 SMR 采集页'))
      document.removeEventListener('visibilitychange', hidden)
      document.removeEventListener('fullscreenchange', fullscreen)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('beforeunload', guard)
    }
  }, [])

  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>, failure: Stage) => {
    if (active.current || !mounted.current) return
    const controller = new AbortController()
    active.current = controller
    setWorking(true)
    try { await operation(controller.signal) }
    catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : String(error))
        show(failure)
      }
    } finally {
      active.current = null
      if (mounted.current) setWorking(false)
    }
  }, [show])

  async function enterFullscreen() {
    if (surface.current && !document.fullscreenElement) await surface.current.requestFullscreen()
  }

  async function checkInput(signal: AbortSignal, appliedOnly = !autoStartModel) {
    if (!liveEegHub.isFresh()) throw new Error('未收到实时 EEG，请先在采集页开流。')
    await connectGroupedSmrModel(signal, setMessage, undefined, appliedOnly)
    const hello = modelRuntimeHub.snapshot.serviceHello
    const localModel = modelUrlPresets().some(preset => preset.url === modelRuntimeHub.snapshot.url)
    const service = localModel ? await modelServiceStatus(signal) : null
    if (!service?.owned || !hello || hello.model_type === 'mock' || smrModelAxes(hello.class_names) !== '1D'
      || ![2, 4].includes(hello.window_sec ?? 0) || hello.supports_group_training === false) {
      throw new Error('请在实验员设置中应用本页托管、支持组间训练的四分类 SMR 模型（2 秒或 4 秒窗口）。')
    }
  }

  function start() {
    void run(async signal => {
      if (!subject.trim()) throw new Error('请输入被试编号。')
      const nextSeed = randomSeed()
      const nextPlan = calibrationPlan(rounds, nextSeed)
      try { await enterFullscreen() }
      catch { throw new Error('浏览器未允许全屏，请在独立浏览器窗口重试。') }
      signal.throwIfAborted()
      show('connecting')
      if (!preview) {
        setMessage('正在检查 EEG 和四分类训练基线…')
        if (!liveEegHub.isFresh()) throw new Error('未收到实时 EEG，请先在采集页开流。')
        storeSubjectId(subject)
        await finalizeActiveRecording()
        signal.throwIfAborted()
        await checkInput(signal)
        await probeRef.current.begin(true, subject, nextSeed, signal)
      }
      signal.throwIfAborted()
      seed.current = nextSeed
      plan.current = nextPlan
      completed.current = 0
      setGuidedCursor(undefined)
      setMessage('')
      show('practice')
    }, 'setup')
  }

  const collect = useCallback(() => run(async signal => {
    const training = probeRef.current
    if (document.hidden || document.fullscreenElement !== surface.current) throw new Error('请回到前台并恢复全屏后继续。')
    if (training.blocked) {
      if (!await training.retry()) throw new Error('组间训练尚未恢复，请查看实验员设置。')
    } else if (completed.current < plan.current.length) {
      setStimulus(null)
      show('connecting')
      setMessage('准备进入本组采集…')
      const baseline = training.round.current?.baseline
      if (!preview) {
        if (!baseline) throw new Error('训练轮次未就绪，请重新设置本轮采集。')
        await confirmModel(baseline, signal)
      }
      signal.throwIfAborted()
      show('collect')
      const present = (next: Stimulus) => new Promise<void>((resolve, reject) => {
        signal.throwIfAborted()
        const abort = () => { cancelAnimationFrame(frame); reject(signal.reason) }
        const frame = requestAnimationFrame(() => {
          signal.removeEventListener('abort', abort)
          flushSync(() => setStimulus(next))
          resolve()
        })
        signal.addEventListener('abort', abort, { once: true })
      })
      const file = await collectBlock(plan.current[completed.current], subject, seed.current, preview,
        training.round.current, signal, present)
      completed.current++
      setStimulus(null)
      show('rest')
      if (file) {
        setMessage('本组已保存，正在用该被试的累计数据训练…')
        if (!await training.finish(file, completed.current === plan.current.length)) {
          throw new Error('本组数据已保存，组间训练待恢复。')
        }
      }
    }
    signal.throwIfAborted()
    if (completed.current < plan.current.length) {
      setMessage('本组处理完成。放松一下，准备好后继续下一组。')
      show('rest')
      return
    }
    const adapted = training.adaptedModel()
    if (!preview && !adapted) {
      setMessage('当前数据尚未选出通过验证的个体化模型。可以追加一组试次，再用累计数据训练。')
      show('rest')
      return
    }
    if (adapted) {
      setMessage('正在确认新模型的实时预测…')
      await confirmModel(adapted, signal)
    }
    if (document.hidden || document.fullscreenElement !== surface.current) throw new Error('请恢复全屏后进入光标控制。')
    setGuidedCursor({ preview, seed: seed.current, revision: adapted?.revision ?? null })
    show('cursor')
  }, 'paused'), [preview, run, show, subject])

  async function continueInFullscreen() {
    try { await enterFullscreen() }
    catch { setMessage('请允许浏览器进入全屏后重试。'); return }
    await collect()
  }

  function reset() {
    probeRef.current.interrupt('实验员结束本轮')
    completed.current = 0
    setMessage('')
    show('setup')
  }

  const resting = stage === 'rest'
  const needsMore = resting && completed.current === plan.current.length && !probe.adaptedModel()
  const locked = stage !== 'setup' || working
  const count = stage === 'setup' ? rounds : plan.current.length
  return <section ref={surface} className="smr-participant smr-guided" aria-label="运动想象实验">
    <button type="button" className="smr-subtle-button smr-guided-operator" onClick={() => {
      setOperatorOpen(true)
      settings.current?.showModal()
    }}>实验员设置</button>
    <dialog ref={settings} className="smr-operator-dialog" aria-label="实验员设置" onClose={() => setOperatorOpen(false)}>
      <div className="smr-operator-heading">
        <h2>采集与训练设置</h2>
        <button type="button" className="smr-subtle-button" onClick={() => settings.current?.close()}>返回被试画面</button>
      </div>
      <LiveEegBadge />
      <section className="smr-operator-section">
        <h3>连接与进度</h3>
        <button type="button" className="btn" disabled={locked} onClick={() => void run(signal => checkInput(signal, true), 'setup')}>检查 EEG 与所选模型</button>
        <p>被试 {subject || '—'}</p>
        <p>当前模型版本 {runtime.serviceHello?.model_revision ?? '未连接'}</p>
        <p>已保存 {completed.current} / {count} 组 · 每组 {calibrationGroupSize} 个试次</p>
        {message && <p role="status">{message}</p>}
        {probe.message && <p>{probe.message}</p>}
        {probe.roundId && <p><a href={`/api/training/rounds/${probe.roundId}`} target="_blank" rel="noreferrer">查看训练记录</a></p>}
        {stage === 'cursor' && <button type="button" className="btn" disabled={cursorBusy || working}
          onClick={() => { settings.current?.close(); reset() }}>结束本轮，重新设置</button>}
      </section>
      <section className="smr-operator-section">
        <h3>组间训练与接管</h3>
        <fieldset disabled={locked} className="smr-operator-fields">
          <label>最小提升（百分点）<input type="number" min={0} max={100} value={minimumGain * 100} onChange={e => setMinimumGain(Number(e.target.value) / 100)} /></label>
          <label>单类召回最多下降（百分点）<input type="number" min={0} max={100} value={maximumRecallDrop * 100} onChange={e => setMaximumRecallDrop(Number(e.target.value) / 100)} /></label>
          {runtime.serviceHello?.model_type !== 'eegnet' && <>
            <label className="smr-operator-check"><input type="checkbox" checked={autoLora} onChange={e => setAutoLora(e.target.checked)} />轮末 LoRA（REVE，同被试数据）</label>
            {autoLora && <>
              <label>LoRA epochs<input type="number" min={1} max={100} value={loraEpochs} onChange={e => setLoraEpochs(Number(e.target.value))} /></label>
              <label>LoRA 学习率<input type="number" min={.000001} max={.01} step={.00001} value={loraLr} onChange={e => setLoraLr(Number(e.target.value))} /></label>
            </>}
          </>}
        </fieldset>
      </section>
      {operatorOpen && <fieldset disabled={locked} style={{ border: 0, padding: 0 }}><ModelServicePanel embedded reveTask="smr_control" /></fieldset>}
      <div className="smr-guided-links"><Link to="/smr-acquisition?mode=grouped">原分组采集与训练</Link></div>
    </dialog>
    {stage === 'practice' ? <Suspense fallback={<p>加载动作练习室…</p>}><Practice onPracticed={collect} /></Suspense>
    : stage === 'cursor' ? <SmrAdaptPage groupedAcquisition autoStartModel={autoStartModel && !preview}
        guidedCursor={guidedCursor} subjectId={subject} onBusyChange={setCursorBusy} />
    : stage === 'collect' && stimulus ? <div className="smr-guided-stimulus" data-phase={stimulus.phase}>
        {stimulus.phase === 'cue' ? <span className="smr-guided-cue">{cueText[stimulus.target]}</span>
          : stimulus.phase === 'prepare' ? <span className="smr-guided-recovery">放松</span>
          : stimulus.phase === 'recover' ? <span className="smr-guided-recovery">等待</span>
          : <div className="smr-participant-fixation" aria-label="中央注视点" />}
      </div>
    : stage === 'setup' ? <form className="smr-guided-setup" onSubmit={e => { e.preventDefault(); start() }}>
        <Link to="/">← 实验目录</Link>
        <h1>运动想象采集</h1>
        <p>先跟随动画熟悉动作，然后每组采集 20 次。提示消失后注视中央圆点，持续想象指定动作，身体保持静止。</p>
        <label>被试编号<input required value={subject} onChange={e => setSubject(e.target.value.trim())} /></label>
        <label>采集组数<input type="number" min="1" max={maxGroups} step="1" required value={rounds || ''} onChange={e => setRounds(Number(e.target.value))} /></label>
        <p>放松 {smrTrialSeconds.prepare} 秒，提示 {smrTrialSeconds.cue} 秒，持续想象 {smrTrialSeconds.imagery} 秒，等待 {smrTrialSeconds.recover} 秒。每组保存后自动训练，确认个体化模型后进入光标控制。</p>
        <label className="smr-guided-preview"><input type="checkbox" checked={preview} onChange={e => setPreview(e.target.checked)} />仅预览流程（模拟光标，不录制）</label>
        {message && <p role="status">{message}</p>}
        <button className="smr-participant-primary" type="submit" disabled={working}>全屏开始熟悉动作</button>
        <div className="smr-guided-links"><Link to="/acquisition">采集调试</Link><Link to="/smr-acquisition?mode=grouped">原分组采集与训练</Link></div>
      </form>
    : <div className="smr-guided-setup">
        <h1>{stage === 'paused' ? '采集已暂停' : resting ? '休息一下' : '准备采集'}</h1>
        <p role="status">{working && resting && probe.message ? probe.message : message}</p>
        {(resting || stage === 'paused') && <p>已保存 {completed.current} / {plan.current.length} 组。</p>}
        {!working && stage === 'paused' && <button className="smr-participant-primary" onClick={() => void continueInFullscreen()}>
          {probe.blocked ? '重试组间训练' : '继续采集'}
        </button>}
        {!working && resting && !needsMore && <button className="smr-participant-primary" onClick={() => void continueInFullscreen()}>继续下一组</button>}
        {!working && needsMore && plan.current.length < maxGroups && <button className="smr-participant-primary" onClick={() => {
          plan.current = calibrationPlan(plan.current.length + 1, seed.current)
          void continueInFullscreen()
        }}>追加一组采集</button>}
        {!working && (resting || stage === 'paused') && <div className="smr-guided-links"><button className="smr-subtle-button" onClick={reset}>结束本轮，重新设置</button></div>}
      </div>}
  </section>
}
