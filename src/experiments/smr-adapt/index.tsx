import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { SessionLogger } from '../../lib/logger'
import {
  ModelServicePanel,
  TemporalFilterControls,
  liveStepSecForReveTask,
  LIVE_PREDICTION_MAX_AGE_MS,
  modelRuntimeHub,
  modelServiceStatus,
  useModelRuntime,
  useTemporalFilter,
} from '../../lib/model-runtime'
import { randomSeed } from '../../lib/rng'
import { preferredModelHead, saveModelHeadPreference, notifyModelSubjectChanged } from '../../lib/model-runtime/modelHeadPreference'
import { connectSmrModel, S04_HEAD } from '../../lib/model-runtime/connectSmrModel'
import {
  startExperimentRecording,
  stopExperimentRecording,
  recorderIsActive,
} from '../../lib/session/recordControl'
import { finalizeActiveRecording } from '../../lib/session/finalizeRecording'
import { ExportButtons, loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import {
  CUE_SEC,
  FEEDBACK_SEC,
  ITI_SEC,
  PLANS,
  POST_SEC,
  advancePhase,
  createSession,
  cueLabel,
  currentTrial,
  finishTrial,
  instructionFor,
  scoreHint,
  scoresByTask,
  startSession,
  groupedPlan,
  resumeGroup,
  type PlanId,
  type SessionState,
} from './engine'
import { loadSmrProfile, proficientSummary, saveSmrProfile } from './profile'
import {
  BalancedNorm,
  SMR_TICK_SEC,
  SMR_WINDOW_SEC,
  alphaPower,
  classSide,
  copyRecentSamples,
  hitEdge,
  laplacianTrace,
  outcomeForHit,
  resetCursor,
  resolveLaplacianMontage,
  reveCursorDrive,
  smrFeatures,
  stepCursor,
  type CursorState,
  type LaplacianMontage,
} from './smrControl'
import './smrAdapt.css'
import type { SmrModeProps } from '../smr/types'
import { useGroupedProbe } from './useGroupedProbe'
import { AcquisitionView } from '../smr-acquisition/AcquisitionView'
import { SMR_IMAGERY_SCHEMA, SMR_TARGET_CLASSES, canLabelSmrHead } from './labels'

type CursorDrive = 'reve' | 'features'

const CURSOR_DRIVE_KEY = 'passive-bci.smr-adapt-cursor-drive'

function loadCursorDrive(): CursorDrive {
  if (typeof window === 'undefined') return 'reve'
  return window.localStorage.getItem(CURSOR_DRIVE_KEY) === 'features' ? 'features' : 'reve'
}

type Welford = { n: number; mean: number; m2: number }

function pushWelford(s: Welford, x: number): void {
  s.n += 1
  const d = x - s.mean
  s.mean += d / s.n
  s.m2 += d * (x - s.mean)
}

function zWelford(s: Welford, x: number): number {
  if (s.n < 12) return 0
  const std = Math.sqrt(s.m2 / Math.max(1, s.n - 1))
  return (x - s.mean) / Math.max(0.05, std)
}

function demoControl(target: 'left' | 'right' | 'up' | 'down'): { zH: number; zV: number } {
  const n = () => (Math.random() - 0.5) * 0.7
  if (target === 'left') return { zH: -1.35 + n(), zV: n() * 0.3 }
  if (target === 'right') return { zH: 1.35 + n(), zV: n() * 0.3 }
  if (target === 'up') return { zH: n() * 0.3, zV: 1.35 + n() }
  return { zH: n() * 0.3, zV: -1.35 + n() }
}

export function SmrAdaptPage({ autoStartModel = true, groupedAcquisition = false, embedded = false, subjectId: sharedSubject, onSubjectChange, onBusyChange }: SmrModeProps & { autoStartModel?: boolean; groupedAcquisition?: boolean } = {}) {
  const [localSubject, setLocalSubject] = useState(() => loadStoredSubjectId('S01'))
  const subjectId = sharedSubject ?? localSubject
  const setSubjectId = onSubjectChange ?? setLocalSubject
  const [starting, setStarting] = useState(false)
  const [preview, setPreview] = useState(false)
  const connectionController = useRef<AbortController | null>(null)
  const recordingRevision = useRef<string | null>(null)
  useEffect(() => () => connectionController.current?.abort(), [])
  const [saving, setSaving] = useState(false)
  const [planId, setPlanId] = useState<PlanId>(groupedAcquisition ? 'grouped' : 'quick')
  const [groupCount, setGroupCount] = useState(3)
  const [groupTrials, setGroupTrials] = useState(20)
  const [groupSaved, setGroupSaved] = useState(false)
  const [autoProbe, setAutoProbe] = useState(true)
  const [minimumGain, setMinimumGain] = useState(0.02)
  const [maximumRecallDrop, setMaximumRecallDrop] = useState(0)
  const [autoLora, setAutoLora] = useState(true)
  const [loraEpochs, setLoraEpochs] = useState(5)
  const [loraLr, setLoraLr] = useState(.0001)
  const probe = useGroupedProbe({ minimumGain, maximumRecallDrop,
    lora: groupedAcquisition && autoLora ? { epochs: loraEpochs, lr: loraLr, rank: 4, alpha: 8, batchSize: 1, accumulationSteps: 8 } : undefined })
  const probeRef = useRef(probe)
  probeRef.current = probe
  const recordingLive = useRef(false)
  const trainingWindowSecRef = useRef(SMR_WINDOW_SEC)
  const stoppingRef = useRef(false)
  const [session, setSession] = useState<SessionState>(() =>
    createSession(groupedAcquisition ? PLANS.grouped : PLANS.quick, randomSeed()),
  )
  const [cursor, setCursor] = useState<CursorState>(resetCursor)
  const [notice, setNotice] = useState('')
  const [startError, setStartError] = useState(false)
  const [horizFlipped, setHorizFlipped] = useState(false)
  const [cursorDrive, setCursorDrive] = useState<CursorDrive>(() => groupedAcquisition ? 'reve' : loadCursorDrive())
  const { config: temporalConfig, setConfig: setTemporalConfig, filterRef: temporalFilterRef } =
    useTemporalFilter(liveStepSecForReveTask('smr_control'))
  const loggerRef = useRef(new SessionLogger('smr-adapt', subjectId))
  const sessionRef = useRef(session)
  const cursorRef = useRef(cursor)
  const horizNorm = useRef(new BalancedNorm())
  const vertNorm = useRef(new BalancedNorm())
  const warmupH = useRef<Welford>({ n: 0, mean: 0, m2: 0 })
  const warmupV = useRef<Welford>({ n: 0, mean: 0, m2: 0 })
  const cursorDriveRef = useRef(cursorDrive)
  const runtime = useModelRuntime()
  const eeg = useLiveEeg()
  const autoTrainingCompatible = runtime.serviceHello?.supports_group_training !== false
    && (!runtime.serviceHello?.window_sec || [2, 4].includes(runtime.serviceHello.window_sec))
  useEffect(() => {
    if (!autoTrainingCompatible) setAutoProbe(false)
  }, [autoTrainingCompatible])

  sessionRef.current = session
  cursorRef.current = cursor
  cursorDriveRef.current = cursorDrive

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    if (!groupedAcquisition) window.localStorage.setItem(CURSOR_DRIVE_KEY, cursorDrive)
  }, [cursorDrive, groupedAcquisition])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const status = await modelServiceStatus(ac.signal)
        if (ac.signal.aborted) return
        // Visiting a page must never replace a running participant model.
        if (!autoStartModel || cursorDrive !== 'reve') return
        if (status.running && status.task === 'smr_control') {
          if (!modelRuntimeHub.snapshot.enabled) modelRuntimeHub.setEnabled(true)
          else if (!['ready', 'connecting'].includes(modelRuntimeHub.snapshot.status)) modelRuntimeHub.connect()
        }
      } catch (error) {
        if (ac.signal.aborted) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setNotice(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => ac.abort()
  }, [cursorDrive, autoStartModel, subjectId])

  const montage = useMemo(
    () => resolveLaplacianMontage(eeg.meta.channelNames),
    [eeg.meta.channelNames],
  )
  const live = eeg.live
  const trial = currentTrial(session)
  const resting = session.phase === 'rest'
  const running = session.phase !== 'idle' && session.phase !== 'done' && !resting
  const workflowLocked = running || resting || starting || saving || probe.busy || probe.blocked
  useLayoutEffect(() => { onBusyChange?.(workflowLocked) }, [onBusyChange, workflowLocked])
  const scores = useMemo(() => scoresByTask(session.trials), [session.trials])
  const hint = useMemo(() => scoreHint(scores), [scores])
  const saved = loadSmrProfile(subjectId)

  async function prepareModel() {
    connectionController.current?.abort()
    const controller = new AbortController()
    connectionController.current = controller
    await connectSmrModel(controller.signal, setNotice, preferredModelHead('smr_control', subjectId))
    controller.signal.throwIfAborted()
    const hello = modelRuntimeHub.snapshot.serviceHello
    if (!hello) throw new Error('模型握手未返回服务信息')
    if (!liveEegHub.isFresh()) throw new Error('模型已连接，但本页没有可录制的原始 EEG 数据，请先连接采集数据流')
    return hello
  }

  async function connectOnly() {
    if (workflowLocked) return
    setStarting(true); setStartError(false)
    try {
      setNotice('正在保存已有录制；保存完成后连接模型…')
      await finalizeActiveRecording()
      await prepareModel()
    }
    catch (error) { setStartError(true); setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setStarting(false) }
  }

  const modelConnectionControls = <section className="smr-operator-section" aria-label="SMR 输入就绪检查">
    <fieldset disabled={workflowLocked} style={{ border: 0, padding: 0 }}>
      <button className="btn" onClick={() => void connectOnly()}>连接 EEG 与所选模型</button>{' '}
      <button className="btn" onClick={() => {
        setSubjectId('S04'); localStorage.setItem('passive-bci.subject-id', 'S04')
        saveModelHeadPreference('smr_control', S04_HEAD, 'S04'); notifyModelSubjectChanged()
        setNotice('已选择 S04 个体化四分类模型，连接或开始时应用。')
      }}>使用 S04 个体化模型</button>
      <label className="smr-operator-check"><input type="checkbox" checked={preview} onChange={e => setPreview(e.target.checked)} />仅演示预览（不录制、不使用模型反馈）</label>
    </fieldset>
    <p data-testid="smr-model-revision">当前模型：{runtime.serviceHello?.model_revision ?? '未连接'} · 窗口 {runtime.serviceHello?.window_sec ?? '—'} 秒</p>
    <p data-testid="smr-probabilities">{runtime.latestPrediction?.class_names.map((name, i) => `${name}: ${((runtime.latestPrediction?.probabilities[i] ?? 0) * 100).toFixed(1)}%`).join(' · ') || '等待真实预测'}</p>
    <p role="status">{notice}</p>
  </section>

  const begin = () => {
    void startRound()
  }

  const startRound = async () => {
    if (workflowLocked) return
    setStartError(false)
    setStarting(true)
    try {
      // The recording lock can belong to this runtime or to a refreshed/old tab.
      // Preserve either kind before prepareModel may load another head.
      setNotice('正在保存已有录制；保存完成后核对模型并开始新一轮…')
      await finalizeActiveRecording()
      const hello = !preview && cursorDrive === 'reve' ? await prepareModel() : null
      const live = !preview && liveEegHub.isFresh()
      if (!preview && !live) throw new Error('EEG 未开流，不能开始正式采集；请连接设备，或明确选择仅演示预览')
      recordingRevision.current = hello?.model_revision ?? null
      trainingWindowSecRef.current = live ? hello?.window_sec ?? SMR_WINDOW_SEC : 0
      const trainingCompatible = hello?.supports_group_training !== false
        && Boolean(hello?.window_sec && [2, 4].includes(hello.window_sec))
      const plan = planId === 'grouped' ? groupedPlan(groupCount, groupTrials) : PLANS[planId]
      horizNorm.current = new BalancedNorm()
      vertNorm.current = new BalancedNorm()
      warmupH.current = { n: 0, mean: 0, m2: 0 }
      warmupV.current = { n: 0, mean: 0, m2: 0 }
      temporalFilterRef.current.reset()
      setHorizFlipped(false)
      const seed = randomSeed()
      await probe.begin(live && planId === 'grouped' && autoProbe && trainingCompatible && cursorDrive === 'reve', subjectId, seed)
      loggerRef.current.clear()
      const notes: string[] = []
      if (live) {
        const rec = await startExperimentRecording({
          experiment: 'smr-adapt',
          subjectId,
          seed,
        })
        if (!rec.ok || rec.sink !== 'disk' || !rec.rel) {
          if (rec.ok) await stopExperimentRecording()
          throw new Error(`无法开始采集：${rec.message}。需要可写入事件的本地会话。`)
        }
        notes.push(rec.message)
      } else {
        notes.push('仅演示预览：使用演示光标，不录制 EEG，不用于训练')
      }
      recordingLive.current = live
      stoppingRef.current = false
      setGroupSaved(false)
      const next = startSession(createSession(plan, seed, performance.now()), performance.now())
      setSession(next)
      setCursor(resetCursor())
      loggerRef.current.log('session_start', {
        roundId: probe.round.current?.id,
        model: probe.round.current?.baseline ?? (recordingRevision.current ? { revision: recordingRevision.current } : null),
        planId,
        seed: next.seed,
        trials: next.trials.length,
        live,
        cursorDrive,
        plan,
        imagerySchema: SMR_IMAGERY_SCHEMA, mapping: SMR_TARGET_CLASSES,
        montage: montage
          ? { c3: montage.neighborNamesC3, c4: montage.neighborNamesC4 }
          : null,
      })
      loggerRef.current.log('group_start', { run: 1, roundId: probe.round.current?.id,
        imagerySchema: SMR_IMAGERY_SCHEMA, mapping: SMR_TARGET_CLASSES,
        model: probe.round.current?.baseline ?? (recordingRevision.current ? { revision: recordingRevision.current } : null), seed, plan, live })
      setNotice(
        live
          ? cursorDrive === 'features'
            ? `C3/C4 mu 驱动光标。${notes.filter(Boolean).join(' ')}`
            : `REVE 驱动光标；SMR 头冻结，不在线微调。${notes.filter(Boolean).join(' ')}`
          : notes.join(' '),
      )
    } catch (error) {
      probe.interrupt('开始采集失败')
      setStartError(true)
      setNotice(error instanceof Error ? error.message : String(error))
    } finally { setStarting(false) }
  }

  const continueGroup = async () => {
    if (!resting || !groupSaved || starting || saving || probe.busy || probe.blocked) return
    setStarting(true)
    try {
      if (recorderIsActive()) {
        const saved = await stopExperimentRecording()
        if (!saved.ok) throw new Error(saved.message)
      }
      if (recordingLive.current && cursorDrive === 'reve') {
        await prepareModel()
      }
      if (recordingLive.current && !liveEegHub.isFresh()) throw new Error('EEG 断流，请恢复采集后继续')
      await probe.check()
      if (recordingLive.current) {
        const result = await startExperimentRecording({ experiment: 'smr-adapt', subjectId, seed: session.seed })
        if (!result.ok || result.sink !== 'disk' || !result.rel) {
          if (result.ok) await stopExperimentRecording()
          throw new Error(result.message)
        }
      }
      temporalFilterRef.current.reset()
      setCursor(resetCursor())
      loggerRef.current.log('group_start', { run: currentTrial(session)?.run, seed: session.seed, plan: session.plan,
        imagerySchema: SMR_IMAGERY_SCHEMA, mapping: SMR_TARGET_CLASSES,
        roundId: probe.round.current?.id, model: probe.round.current?.baseline ?? (recordingRevision.current ? { revision: recordingRevision.current } : null), live: recordingLive.current })
      setGroupSaved(false)
      setSession(resumeGroup(session, performance.now()))
    } catch (error) { setNotice(String(error)) }
    finally { setStarting(false) }
  }

  const persist = useCallback((state: SessionState, montageNow: LaplacianMontage | null) => {
    const nextScores = scoresByTask(state.trials)
    const profile = {
      subjectId,
      updatedAt: new Date().toISOString(),
      planId: state.plan.id,
      seed: state.seed,
      c3Neighbors: montageNow?.neighborNamesC3 ?? [],
      c4Neighbors: montageNow?.neighborNamesC4 ?? [],
      horizMean: horizNorm.current.stats()?.mean ?? null,
      horizStd: horizNorm.current.stats()?.std ?? null,
      horizSign: horizNorm.current.polarity(),
      vertMean: vertNorm.current.stats()?.mean ?? null,
      vertStd: vertNorm.current.stats()?.std ?? null,
      scores: nextScores,
      trials: state.trials.filter((item) => item.outcome).length,
    }
    saveSmrProfile(profile)
    loggerRef.current.log('profile_saved', profile)
  }, [subjectId])

  const interruptGroup = useCallback((reason: string) => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    probeRef.current.interrupt(reason)
    const current = sessionRef.current
    const item = currentTrial(current)
    loggerRef.current.log('group_interrupted', { run: item?.run, index: item?.index, reason, complete: false })
    loggerRef.current.log('trial_invalid', { index: item?.index, run: item?.run, reason })
    const stopped: SessionState = { ...current, phase: 'done', phaseStartedAt: performance.now() }
    sessionRef.current = stopped
    setSession(stopped)
    setGroupSaved(false)
    setSaving(true)
    void (async () => {
      const result = recordingLive.current ? await stopExperimentRecording() : null
      setNotice(`本组已中断（${reason}），不得作为完整组训练。${result?.message ?? '演示未落盘'}。请检查后重新开始。`)
    })().catch(error => setNotice(`中断保存失败：${String(error)}`)).finally(() => {
      setSaving(false)
      stoppingRef.current = false
    })
  }, [])

  useEffect(() => {
    if (!running || !session.plan.restBetweenRuns) return
    const hidden = () => { if (document.hidden) interruptGroup('页面隐藏') }
    const preventClose = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', preventClose)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', preventClose)
    }
  }, [running, session.plan.restBetweenRuns, interruptGroup])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      const now = performance.now()
      const current = sessionRef.current
      const elapsed = (now - current.phaseStartedAt) / 1000
      const item = currentTrial(current)
      if (stoppingRef.current) return
      if (current.plan.restBetweenRuns && recordingLive.current && !liveEegHub.isFresh()) {
        interruptGroup('EEG 断流')
        return
      }

      if (current.phase === 'iti' && elapsed >= ITI_SEC) {
        const next = advancePhase(current, now)
        setSession(next)
        setCursor(resetCursor())
        const nextTrial = currentTrial(next)
        loggerRef.current.log('cue', { index: nextTrial?.index, run: nextTrial?.run, target: nextTrial?.target, task: nextTrial?.task })
        return
      }
      if (current.phase === 'cue' && elapsed >= CUE_SEC) {
        temporalFilterRef.current.reset()
        loggerRef.current.log('feedback_start', { index: item?.index, run: item?.run, target: item?.target })
        setSession(advancePhase(current, now))
        setCursor(resetCursor())
        return
      }
      if (current.phase === 'post' && elapsed >= POST_SEC) {
        const next = advancePhase(current, now)
        sessionRef.current = next
        setSession(next)
        setCursor(resetCursor())
        if (next.phase === 'done' || next.phase === 'rest') {
          if (next.phase === 'done') persist(next, montage)
          loggerRef.current.log('group_end', { run: item?.run, complete: true, seed: next.seed,
            roundId: probeRef.current.round.current?.id, model: probeRef.current.round.current?.baseline })
          if (!recordingLive.current) {
            setGroupSaved(true)
            setNotice('演示组已结束，未保存 EEG，也不会用于训练。可继续下一组。')
            return
          }
          setSaving(true)
          void stopExperimentRecording().then(async (result) => {
            if (!result.ok || !result.rel) throw new Error(`未确认数据保存，禁止继续：${result.message}`)
            const ready = await probeRef.current.finish(result.rel, next.phase === 'done')
            setGroupSaved(ready)
            if (result.message) setNotice(result.message)
          }).catch(error => setNotice(String(error))).finally(() => setSaving(false))
        }
        return
      }
      if (current.phase !== 'feedback' || !item) return

      let zH: number
      let zV: number
      const useReve = cursorDriveRef.current === 'reve'
      const pred = useReve && recordingLive.current ? modelRuntimeHub.latestObservation(LIVE_PREDICTION_MAX_AGE_MS) : null
      if (useReve && recordingLive.current && (modelRuntimeHub.snapshot.status !== 'ready' || !pred
        || pred.probabilities.length !== pred.class_names.length || pred.probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1))) {
        interruptGroup('REVE 预测中断')
        return
      }
      if (pred && canLabelSmrHead(pred.class_names) && pred.probabilities.length === pred.class_names.length) {
        const decision = temporalFilterRef.current.observePrediction(pred)
        const axes = reveCursorDrive(decision)
        zH = axes.zH
        zV = axes.zV
      } else if (!useReve && recordingLive.current && live && montage) {
        const { buffers, writeHead, filled, sampleRate } = liveEegHub.ring
        const n = Math.round(sampleRate * SMR_WINDOW_SEC)
        const c3 = copyRecentSamples(buffers[montage.c3]!, writeHead, filled, n)
        const c4 = copyRecentSamples(buffers[montage.c4]!, writeHead, filled, n)
        if (c3.length < 20 || c4.length < 20) return
        const nC3 = montage.neighborsC3.map((idx) =>
          copyRecentSamples(buffers[idx]!, writeHead, filled, n),
        )
        const nC4 = montage.neighborsC4.map((idx) =>
          copyRecentSamples(buffers[idx]!, writeHead, filled, n),
        )
        const pC3 = alphaPower(laplacianTrace(c3, nC3), sampleRate)
        const pC4 = alphaPower(laplacianTrace(c4, nC4), sampleRate)
        const raw = smrFeatures(pC3, pC4)
        const sideH = classSide(item.target, 'horiz')
        const sideV = classSide(item.target, 'vert')
        if (sideH) horizNorm.current.push(sideH, raw.horiz)
        if (sideV) vertNorm.current.push(sideV, raw.vert)
        if (horizNorm.current.flipped()) setHorizFlipped(true)
        pushWelford(warmupH.current, raw.horiz)
        pushWelford(warmupV.current, raw.vert)
        zH = horizNorm.current.stats() ? horizNorm.current.z(raw.horiz) : zWelford(warmupH.current, raw.horiz)
        zV = vertNorm.current.stats() ? vertNorm.current.z(raw.vert) : zWelford(warmupV.current, raw.vert)
      } else if (recordingLive.current) {
        if (elapsed >= FEEDBACK_SEC) {
          const next = finishTrial(current, 'timeout', null, elapsed, now)
          setSession(next)
          loggerRef.current.log('trial', {
            imagerySchema: SMR_IMAGERY_SCHEMA, className: SMR_TARGET_CLASSES[item.target],
            index: item.index,
            run: item.run,
            valid: false,
            invalidReason: 'eeg_unavailable',
            task: item.task,
            target: item.target,
            outcome: 'timeout',
            hit: null,
            feedbackSec: elapsed,
          })
        }
        return
      } else {
        const demo = demoControl(item.target)
        zH = demo.zH
        zV = demo.zV
      }

      const nextCursor = stepCursor(cursorRef.current, item.task, zH, zV, SMR_TICK_SEC)
      cursorRef.current = nextCursor
      setCursor(nextCursor)
      const hit = hitEdge(nextCursor)
      // Keep motor imagery active for one complete model window. Otherwise an
      // early cursor hit removes that class from the offline training set.
      if ((hit && elapsed >= trainingWindowSecRef.current) || elapsed >= FEEDBACK_SEC) {
        const outcome = outcomeForHit(item.target, hit, elapsed >= FEEDBACK_SEC)
        const next = finishTrial(current, outcome, hit, elapsed, now)
        setSession(next)
        loggerRef.current.log('trial', {
          imagerySchema: SMR_IMAGERY_SCHEMA, className: SMR_TARGET_CLASSES[item.target],
          index: item.index,
          run: item.run,
          live: recordingLive.current,
          task: item.task,
          target: item.target,
          outcome,
          hit,
          feedbackSec: elapsed,
        })
      }
    }, Math.round(SMR_TICK_SEC * 1000))
    return () => window.clearInterval(id)
  }, [running, live, montage, subjectId, persist, interruptGroup])

  const flash =
    session.phase === 'post' && trial?.outcome === 'hit'
      ? 'smr-flash-hit'
      : session.phase === 'post' && trial?.outcome && trial.outcome !== 'hit'
        ? 'smr-flash-miss'
        : ''

  if (groupedAcquisition) return <AcquisitionView
    session={session} trial={trial} cursor={cursor} running={running} starting={starting}
    processing={saving || probe.busy} blocked={startError || probe.blocked || (resting && !groupSaved && !saving && !probe.busy)}
    canContinue={groupSaved && !saving && !starting && !probe.busy && !probe.blocked}
    locked={workflowLocked} live={live} preview={preview} onStart={startRound} onContinue={continueGroup} onStop={interruptGroup}
    statusMessage={probe.blocked ? probe.message : notice}
    operator={<>
      <LiveEegBadge />
      {modelConnectionControls}
      <fieldset disabled={workflowLocked} style={{ border: 0, padding: 0, marginTop: 16 }}>
        <ExportButtons logger={loggerRef.current} subjectId={subjectId} onSubjectChange={setSubjectId}
          experiment="smr-adapt" />
      </fieldset>
      <section className="smr-operator-section">
        <h3>采集计划</h3>
        <fieldset className="smr-operator-fields" disabled={workflowLocked}>
          <label>每轮组数<input type="number" min={1} max={50} value={groupCount} onChange={e => setGroupCount(Number(e.target.value))} /></label>
          <label>每组试次数<input type="number" min={4} max={200} step={4} value={groupTrials} onChange={e => setGroupTrials(Number(e.target.value))} /></label>
          <label>光标驱动<select value={cursorDrive} onChange={e => setCursorDrive(e.target.value as CursorDrive)}>
            <option value="reve">REVE 四分类</option><option value="features">C3/C4 mu</option>
          </select></label>
          <label className="smr-operator-check"><input type="checkbox" checked={autoProbe} disabled={!autoTrainingCompatible} onChange={e => setAutoProbe(e.target.checked)} />组间自动训练并评估接管</label>
          {!autoTrainingCompatible && <p>当前导入模型的预处理尚未接入组间训练，已关闭自动训练。推理和原始数据保存照常进行。</p>}
          {autoProbe && cursorDrive === 'reve' && <>
            <label className="smr-operator-check"><input type="checkbox" checked={autoLora} onChange={e => setAutoLora(e.target.checked)} />轮末 LoRA（同被试历史数据）</label>
            {autoLora && <>
              <label>LoRA epochs<input type="number" min={1} max={100} value={loraEpochs} onChange={e => setLoraEpochs(Number(e.target.value))} /></label>
              <label>LoRA 学习率<input type="number" min={.000001} max={.01} step={.00001} value={loraLr} onChange={e => setLoraLr(Number(e.target.value))} /></label>
            </>}
            <label>最小提升（百分点）<input type="number" min={0} max={100} value={minimumGain * 100} onChange={e => setMinimumGain(Number(e.target.value) / 100)} /></label>
            <label>单类召回最多下降（百分点）<input type="number" min={0} max={100} value={maximumRecallDrop * 100} onChange={e => setMaximumRecallDrop(Number(e.target.value) / 100)} /></label>
          </>}
        </fieldset>
        <p className="smr-operator-status">准备 2 秒 · 提示 2 秒 · 执行最多 6 秒 · 结束 1 秒。每组前半水平、后半垂直；只控制一个轴，各方向等量随机，组间保存后继续。</p>
        {autoProbe && autoLora && cursorDrive === 'reve' && <p className="smr-operator-status">轮末从当前模型初始化，联合更新 LoRA 与分类头；rank 4 / alpha 8，batch 1，累积 8 步。历史验证与测试试次不进入训练；验证达标且模型载入检查通过后，下一轮使用选定模型。失败则恢复原模型。</p>}
        {cursorDrive === 'features' && <p className="smr-operator-status">C3/C4 模式仅采集，不自动训练或接管。{!montage && live ? '当前导联缺少 C3/C4。' : ''}</p>}
        {cursorDrive === 'reve' && <fieldset disabled={workflowLocked} style={{ border: 0, padding: 0 }}>
          <TemporalFilterControls config={temporalConfig} onChange={setTemporalConfig} compact />
        </fieldset>}
      </section>
      <section className="smr-operator-section">
        <h3>运行状态与结果</h3>
        <div className="smr-operator-status" role="status">
          {notice && <p>{notice}</p>}
          {probe.message && <p>{probe.message}</p>}
          <p>当前预测：{runtime.latestPrediction?.class_name ?? '—'} · 策略：{runtime.serviceHello?.strategy ?? '—'}</p>
          {scores.map(row => <p key={row.task}>命中 {row.hits} · 未命中 {row.misses} · 超时 {row.timeouts} · PVC {(row.pvc * 100).toFixed(0)}%</p>)}
        </div>
        {probe.blocked && <button className="btn" disabled={probe.busy || saving} onClick={() => { void probe.retry().then(setGroupSaved) }}>恢复并重试组间处理</button>}
        {(running || resting || probe.blocked) && <button className="btn" disabled={saving || starting || probe.busy} onClick={() => interruptGroup('手动终止')}>终止本轮</button>}
        {probe.roundId && <p><a href={`/api/training/rounds/${probe.roundId}`} target="_blank" rel="noreferrer">查看本轮训练与模型记录</a></p>}
      </section>
      <section className="smr-operator-section">
        <h3>模型连接</h3>
        <fieldset disabled={workflowLocked} style={{ border: 0, padding: 0 }}><ModelServicePanel embedded reveTask="smr_control" /></fieldset>
      </section>
    </>}
  />

  return (
    <div className={embedded ? "smr-protocol" : "mx-auto max-w-6xl px-6 py-8"}>
      {modelConnectionControls}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          {!embedded && <Link to="/" className="muted text-sm hover:text-[var(--text)]">
            ← 返回首页
          </Link>}
          {embedded ? <h2>运动想象 · 个体化适配</h2> : <h1 className="m-0 mt-2 text-2xl font-semibold tracking-tight">{groupedAcquisition ? 'SMR 分组采集与训练' : 'SMR 个体化适配'}</h1>}
          {!embedded && !groupedAcquisition && <Link to="/smr-gaze" className="btn mt-3">全屏 SMR 采集</Link>}
          <p className="muted mt-1 max-w-2xl text-sm">
            {groupedAcquisition ? '四方向均衡随机采集；每组保存后训练分类头、评估并选择模型，就绪后手动继续下一组。请先连接 EEG 并开流。' : <>
            Stieger 式连续光标：左手左、右手右、舌头上、休息下。光标可选 REVE 四分类或原来的 C3/C4 mu。SMR 头冻结，不在线微调。只展示上下可去{' '}
            <Link to="/smr-ud" style={{ color: 'var(--accent)' }}>
              SMR 上下控制
            </Link>
            。
            </>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <LiveEegBadge />
            <fieldset disabled={workflowLocked} style={{ border: 0, padding: 0 }}><ExportButtons
            logger={loggerRef.current}
            subjectId={subjectId}
            onSubjectChange={setSubjectId}
            experiment="smr-adapt"
            recordControl
          /></fieldset>
        </div>
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <Panel
          title="光标任务"
          actions={
            <span className="muted text-xs">
              {trial ? `${trial.task} · ${trial.index + 1}/${session.trials.length}` : session.plan.label}
            </span>
          }
        >
          <div className={`smr-arena ${flash}`}>
            {trial && (session.phase === 'cue' || session.phase === 'feedback' || session.phase === 'post') ? (
              <div className={`smr-target is-${trial.target}`} />
            ) : null}
            {session.phase === 'feedback' ? (
              <div
                className="smr-cursor"
                style={{ left: `${cursor.x * 100}%`, top: `${(1 - cursor.y) * 100}%` }}
              />
            ) : null}
            {session.phase === 'iti' || session.phase === 'idle' || session.phase === 'done' || resting ? (
              <div className="smr-overlay">
                <p>
                  {resting ? (probe.busy || saving ? '组间休息：正在保存、训练或检查模型' : probe.blocked ? '组间处理待恢复' : '组间休息：可以继续') : session.phase === 'done'
                    ? proficientSummary(scores)
                    : session.phase === 'iti'
                      ? '准备'
                      : instructionFor(PLANS[planId].blocks[0]?.task ?? 'LR')}
                </p>
              </div>
            ) : session.phase === 'cue' && trial ? (
              <div className="smr-overlay">
                <p>{cueLabel(trial.target)}</p>
              </div>
            ) : null}
          </div>
          <p className="muted mb-0 mt-3 text-sm">
            {trial
              ? instructionFor(trial.task)
              : cursorDrive === 'features'
                ? '选择计划后开始。黄条是目标，粉球由 C3/C4 alpha 推动。'
                : '选择计划后开始。黄条是目标，粉球由 REVE 四分类推动。'}
          </p>
        </Panel>

        <div className="space-y-4">
          <Panel title={groupedAcquisition ? '采集与训练配置' : '计划'}>
            {!groupedAcquisition && <div className="mb-3 flex flex-wrap gap-2">
              {(Object.keys(PLANS) as PlanId[]).filter(id => id !== 'grouped').map((id) => (
                <button
                  key={id}
                  type="button"
                  className="btn"
                  disabled={workflowLocked}
                  onClick={() => {
                    setPlanId(id)
                    setSession(createSession(PLANS[id], randomSeed()))
                  }}
                  style={
                    planId === id
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                      : undefined
                  }
                >
                  {PLANS[id].label}
                </button>
              ))}
            </div>}
            <p className="muted mt-0 text-sm">{PLANS[planId].hint}</p>
            {planId === 'grouped' && <fieldset disabled={workflowLocked}>
              <legend>试运行配置（正式实验参数待确认）</legend>
              <label>每轮组数 <input type="number" min={1} max={50} value={groupCount} onChange={e => setGroupCount(Number(e.target.value))} /></label>
              <label>每组试次数 <input type="number" min={4} max={200} step={4} value={groupTrials} onChange={e => setGroupTrials(Number(e.target.value))} /></label>
              <p className="muted text-sm">左手→左，右手→右，舌头→上，休息→下。准备 2 秒、提示 2 秒、执行最多 6 秒、结束 1 秒。</p>
              <label><input type="checkbox" checked={autoProbe} disabled={!autoTrainingCompatible} onChange={e => setAutoProbe(e.target.checked)} />组间自动训练并评估接管（REVE 四分类）</label>
              {!autoTrainingCompatible && <p>当前导入模型的预处理尚未接入组间训练，已关闭自动训练。推理和原始数据保存照常进行。</p>}
              {autoProbe && cursorDrive === 'reve' && <>
                <label>最小提升（百分点） <input type="number" min={0} max={100} step={1} value={minimumGain * 100} onChange={e => setMinimumGain(Number(e.target.value) / 100)} /></label>
                <label>单类召回最多下降（百分点） <input type="number" min={0} max={100} step={1} value={maximumRecallDrop * 100} onChange={e => setMaximumRecallDrop(Number(e.target.value) / 100)} /></label>
                <p className="muted text-sm">试运行参数：本轮累计训练，首次足量数据固定验证／测试试次；每类至少 3 个有效试次。休息时训练 100 轮，完成模型检查后手动继续。轮末 LoRA 尚未接入。</p>
              </>}
              {autoProbe && cursorDrive === 'features' && <p className="muted text-sm">C3/C4 模式仅分组采集；切换到 REVE 四分类后可使用自动训练与接管。</p>}
            </fieldset>}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="muted text-sm">光标驱动</span>
              {(
                [
                  ['reve', 'REVE 四分类'],
                  ['features', 'C3/C4 mu'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="btn"
                  disabled={workflowLocked}
                  onClick={() => setCursorDrive(id)}
                  style={
                    cursorDrive === id
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                      : undefined
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {cursorDrive === 'reve' ? (
              <fieldset disabled={workflowLocked} className="mb-3" style={{ border: 0, padding: 0 }}>
                <TemporalFilterControls config={temporalConfig} onChange={setTemporalConfig} compact />
              </fieldset>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={workflowLocked} onClick={begin}>
              {session.phase === 'done' ? '再做一轮' : groupedAcquisition ? '开始本轮采集' : '开始适配'}
            </button>
            {resting && <button className="btn btn-primary" disabled={!groupSaved || saving || starting || probe.busy || probe.blocked} onClick={() => void continueGroup()}>{saving || probe.busy ? '正在处理…' : '继续下一组'}</button>}
            {probe.blocked && <button className="btn" disabled={probe.busy || saving} onClick={() => { void probe.retry().then(setGroupSaved) }}>恢复并重试组间处理</button>}
            {(running || resting || probe.blocked) && <button className="btn" disabled={saving || starting || probe.busy} onClick={() => interruptGroup('手动终止')}>终止本轮</button>}
            {notice ? <p className="muted mb-0 mt-3 text-sm">{notice}</p> : null}
            {probe.message && <p role="status" className="mt-3 text-sm">{probe.message}</p>}
            {probe.roundId && <a className="text-sm" href={`/api/training/rounds/${probe.roundId}`} target="_blank" rel="noreferrer">查看本轮训练与模型记录</a>}
            {!montage && live && cursorDrive === 'features' ? (
              <p className="mb-0 mt-3 text-sm" style={{ color: 'var(--danger)' }}>
                当前导联没有 C3/C4，无法计算 Stieger 控制律。
              </p>
            ) : null}
          </Panel>

          <Panel title="本轮">
            {scores.length === 0 ? (
              <p className="muted mb-0 text-sm">还没有完成的试次。</p>
            ) : (
              <ul className="m-0 list-none space-y-2 p-0 text-sm">
                {scores.map((row) => (
                  <li key={row.task}>
                    <strong>{row.task}</strong> PVC {(row.pvc * 100).toFixed(0)}%{' '}
                    {row.proficient ? '达标' : '未达标'}
                    <span className="muted">
                      {' '}
                      · {row.hits} 中 / {row.misses} 错 / {row.timeouts} 超时
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {hint ? (
              <p className="mb-0 mt-3 text-sm" style={{ color: 'var(--warn)' }}>
                {hint}
              </p>
            ) : (
              <p className="muted mb-0 mt-3 text-sm">
                1D 达标 70%，2D 40%。REST 不是脚/舌想象，是主动放空。
              </p>
            )}
            {horizFlipped ? (
              <p className="mb-0 mt-2 text-sm" style={{ color: 'var(--accent-2)' }}>
                已按你的 C3/C4 类均值翻转左右极性。
              </p>
            ) : null}
          </Panel>
        </div>
      </div>

      <Panel title="基模连接 + 离线落盘" className="mb-4">
        <p className="muted mt-0 text-sm">
          {cursorDrive === 'features'
            ? '光标按原来的 C3/C4 Laplacian mu 走（左右极性可按类均值翻转）。SMR 头冻结，本页不向 REVE 打标签。'
            : '光标由已拟合的 REVE 四分类头驱动（左← 右→ 舌头↑ 休息↓）。没有预测时回退 C3/C4 mu。SMR 头冻结，不在线微调。'}
        </p>
        <p className="text-sm">
          当前预测 <strong>{runtime.latestPrediction?.class_name ?? '—'}</strong>
          {' · '}
          策略 <strong>{runtime.serviceHello?.strategy ?? '—'}</strong>
        </p>
        {saved ? (
          <p className="muted text-sm">
            上次 {saved.subjectId}：{proficientSummary(saved.scores)}
          </p>
        ) : null}
        <p className="mb-0 text-sm">
          离线再训：<code>npm run model-service:reve:smr:fit</code>，会读
          recordings/*smr-adapt* 里的 trial。三类任务头请去{' '}
          <Link to="/online-learn">基模在线学习</Link>。
        </p>
      </Panel>

      <Panel title="模型连接">
        <p className="muted mt-0 mb-3 text-sm">
          {cursorDrive === 'reve'
            ? '当前会拉起冻结的 smr_control（strategy=none）。开始适配后自动录制；结束后自动停录并保留 bin。'
            : '特征驱动不自动拉起 REVE。需要 REVE 光标时再在下面启动 smr_control。开始适配后自动录制。'}
        </p>
        <fieldset disabled={workflowLocked} style={{ border: 0, padding: 0 }}><ModelServicePanel embedded reveTask="smr_control" /></fieldset>
      </Panel>
    </div>
  )
}
