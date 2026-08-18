import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { SessionLogger } from '../../lib/logger'
import {
  ModelServicePanel,
  ensureModelService,
  modelRuntimeHub,
  modelServiceStatus,
  useModelRuntime,
} from '../../lib/model-runtime'
import { randomSeed } from '../../lib/rng'
import {
  startExperimentRecording,
  stopExperimentRecording,
} from '../../lib/session/recordControl'
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
  type PlanId,
  type SessionState,
} from './engine'
import { canLabelSmrHead, labelIndexForTarget } from './labels'
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
  smrFeatures,
  stepCursor,
  type CursorState,
  type LaplacianMontage,
} from './smrControl'
import './smrAdapt.css'

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

export function SmrAdaptPage() {
  const [subjectId, setSubjectId] = useState(() => loadStoredSubjectId('S01'))
  const [planId, setPlanId] = useState<PlanId>('quick')
  const [session, setSession] = useState<SessionState>(() =>
    createSession(PLANS.quick, randomSeed()),
  )
  const [cursor, setCursor] = useState<CursorState>(resetCursor)
  const [notice, setNotice] = useState('')
  const [labeled, setLabeled] = useState(0)
  const [horizFlipped, setHorizFlipped] = useState(false)
  const loggerRef = useRef(new SessionLogger('smr-adapt', subjectId))
  const sessionRef = useRef(session)
  const cursorRef = useRef(cursor)
  const horizNorm = useRef(new BalancedNorm())
  const vertNorm = useRef(new BalancedNorm())
  const warmupH = useRef<Welford>({ n: 0, mean: 0, m2: 0 })
  const warmupV = useRef<Welford>({ n: 0, mean: 0, m2: 0 })
  const labeledIds = useRef(new Set<string>())
  const runtime = useModelRuntime()
  const eeg = useLiveEeg()

  sessionRef.current = session
  cursorRef.current = cursor

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const status = await modelServiceStatus(ac.signal)
        if (ac.signal.aborted) return
        if (status.running && status.task === 'smr_control') {
          modelRuntimeHub.setEnabled(true)
          modelRuntimeHub.connect()
          return
        }
        setNotice('正在启动 REVE SMR 头（首次加载权重可能要一两分钟）…')
        const result = await ensureModelService({
          backend: 'reve',
          task: 'smr_control',
          force: Boolean(status.running && status.task && status.task !== 'smr_control'),
          signal: ac.signal,
        })
        if (ac.signal.aborted) return
        setNotice(result.message ?? 'REVE SMR 头已启动')
        modelRuntimeHub.setEnabled(true)
        modelRuntimeHub.connect()
      } catch (error) {
        if (ac.signal.aborted) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setNotice(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => ac.abort()
  }, [])

  const montage = useMemo(
    () => resolveLaplacianMontage(eeg.meta.channelNames),
    [eeg.meta.channelNames],
  )
  const live = eeg.live
  const classNames = runtime.latestPrediction?.class_names ?? runtime.serviceHello?.class_names
  const canLabel = runtime.status === 'ready' && canLabelSmrHead(classNames)

  const trial = currentTrial(session)
  const running = session.phase !== 'idle' && session.phase !== 'done'
  const scores = useMemo(() => scoresByTask(session.trials), [session.trials])
  const hint = useMemo(() => scoreHint(scores), [scores])
  const saved = loadSmrProfile(subjectId)

  const begin = () => {
    void startRound()
  }

  const startRound = async () => {
    horizNorm.current = new BalancedNorm()
    vertNorm.current = new BalancedNorm()
    warmupH.current = { n: 0, mean: 0, m2: 0 }
    warmupV.current = { n: 0, mean: 0, m2: 0 }
    labeledIds.current.clear()
    setLabeled(0)
    setHorizFlipped(false)
    const seed = randomSeed()
    loggerRef.current.clear()
    const notes: string[] = []
    if (live) {
      const rec = await startExperimentRecording({
        experiment: 'smr-adapt',
        subjectId,
        seed,
      })
      notes.push(rec.message)
    } else {
      notes.push('未开流，使用演示光标（不写 REVE / 不落盘）')
    }
    const next = startSession(createSession(PLANS[planId], seed, performance.now()), performance.now())
    setSession(next)
    setCursor(resetCursor())
    loggerRef.current.log('session_start', {
      planId,
      seed: next.seed,
      trials: next.trials.length,
      live,
      montage: montage
        ? { c3: montage.neighborNamesC3, c4: montage.neighborNamesC4 }
        : null,
    })
    setNotice(
      live
        ? `实时 EEG 控制光标；REVE 在线更新 SMR 头。${notes.filter(Boolean).join(' ')}`
        : notes.join(' '),
    )
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

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      const now = performance.now()
      const current = sessionRef.current
      const elapsed = (now - current.phaseStartedAt) / 1000
      const item = currentTrial(current)

      if (current.phase === 'iti' && elapsed >= ITI_SEC) {
        const next = advancePhase(current, now)
        setSession(next)
        setCursor(resetCursor())
        const nextTrial = currentTrial(next)
        loggerRef.current.log('cue', { target: nextTrial?.target, task: nextTrial?.task })
        return
      }
      if (current.phase === 'cue' && elapsed >= CUE_SEC) {
        setSession(advancePhase(current, now))
        setCursor(resetCursor())
        return
      }
      if (current.phase === 'post' && elapsed >= POST_SEC) {
        const next = advancePhase(current, now)
        setSession(next)
        setCursor(resetCursor())
        if (next.phase === 'done') {
          persist(next, montage)
          void stopExperimentRecording().then((result) => {
            if (result.message) setNotice(result.message)
          })
        }
        return
      }
      if (current.phase !== 'feedback' || !item) return

      let zH: number
      let zV: number
      if (live && montage) {
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
      } else {
        const demo = demoControl(item.target)
        zH = demo.zH
        zV = demo.zV
      }

      const nextCursor = stepCursor(cursorRef.current, item.task, zH, zV, SMR_TICK_SEC)
      cursorRef.current = nextCursor
      setCursor(nextCursor)
      const hit = hitEdge(nextCursor)
      if (hit || elapsed >= FEEDBACK_SEC) {
        const outcome = outcomeForHit(item.target, hit, elapsed >= FEEDBACK_SEC)
        const next = finishTrial(current, outcome, hit, elapsed, now)
        setSession(next)
        loggerRef.current.log('trial', {
          index: item.index,
          task: item.task,
          target: item.target,
          outcome,
          hit,
          feedbackSec: elapsed,
        })
      }
    }, Math.round(SMR_TICK_SEC * 1000))
    return () => window.clearInterval(id)
  }, [running, live, montage, subjectId, persist])

  useEffect(() => {
    const imagery = session.phase === 'cue' || session.phase === 'feedback'
    if (!imagery || !trial || !canLabel || !live) return
    const obs = modelRuntimeHub.latestObservation(2500)
    if (!obs || labeledIds.current.has(obs.observation_id)) return
    const label = labelIndexForTarget(obs.class_names, trial.target)
    if (label == null) return
    const className = obs.class_names[label] ?? trial.target
    const feedbackId = modelRuntimeHub.submitFeedback({
      observationId: obs.observation_id,
      label,
      metadata: {
        experiment: 'smr-adapt',
        subjectId,
        target: trial.target,
        task: trial.task,
        phase: session.phase,
        className,
      },
    })
    if (!feedbackId) return
    labeledIds.current.add(obs.observation_id)
    setLabeled((n) => n + 1)
    loggerRef.current.log('smr_window', {
      observationId: obs.observation_id,
      windowId: obs.window_id,
      feedbackId,
      label,
      className,
      classNames: obs.class_names,
      pred: obs.class_name,
      predId: obs.class_id,
      confidence: obs.confidence,
      probabilities: obs.probabilities,
      onlineUpdateStep: obs.online_update_step,
      target: trial.target,
      task: trial.task,
      trialIndex: trial.index,
      phase: session.phase,
      windowSec: runtime.windowSec,
    })
    loggerRef.current.log('foundation_label', {
      observationId: obs.observation_id,
      label,
      className,
      target: trial.target,
      task: trial.task,
      trialIndex: trial.index,
      phase: session.phase,
    })
  }, [session.phase, trial, canLabel, live, subjectId, runtime.latestPrediction?.observation_id, runtime.windowSec])

  const flash =
    session.phase === 'post' && trial?.outcome === 'hit'
      ? 'smr-flash-hit'
      : session.phase === 'post' && trial?.outcome && trial.outcome !== 'hit'
        ? 'smr-flash-miss'
        : ''

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-[var(--text)]">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-2 text-2xl font-semibold tracking-tight">SMR 个体化适配</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            Stieger 式连续光标：左手左、右手右、双手上、休息下。点「开始适配」会同时开录
            EEG，线索期和反馈期按目标给 REVE smr_control 头打标签（在线更新），事件写入
            events.jsonl 供离线再训。
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <LiveEegBadge />
          <ExportButtons
            logger={loggerRef.current}
            subjectId={subjectId}
            onSubjectChange={setSubjectId}
            experiment="smr-adapt"
            recordControl
          />
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
            {session.phase === 'iti' || session.phase === 'idle' || session.phase === 'done' ? (
              <div className="smr-overlay">
                <p>
                  {session.phase === 'done'
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
            {trial ? instructionFor(trial.task) : '选择计划后开始。黄条是目标，粉球由 C3/C4 alpha 推动。'}
          </p>
        </Panel>

        <div className="space-y-4">
          <Panel title="计划">
            <div className="mb-3 flex flex-wrap gap-2">
              {(Object.keys(PLANS) as PlanId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className="btn"
                  disabled={running}
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
            </div>
            <p className="muted mt-0 text-sm">{PLANS[planId].hint}</p>
            <button type="button" className="btn btn-primary" disabled={running} onClick={begin}>
              {session.phase === 'done' ? '再做一轮' : '开始适配'}
            </button>
            {notice ? <p className="muted mb-0 mt-3 text-sm">{notice}</p> : null}
            {!montage && live ? (
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

      <Panel title="基模在线 + 离线落盘" className="mb-4">
        <p className="muted mt-0 text-sm">
          光标仍用 C3/C4 mu。REVE 是独立的 smr_control
          头，线索/反馈期按目标在线更新，同时把每个 2 秒窗记进当前会话。
        </p>
        <p className="text-sm">
          当前预测 <strong>{runtime.latestPrediction?.class_name ?? '—'}</strong>
          {' · '}
          步数 <strong>{runtime.latestPrediction?.online_update_step ?? 0}</strong>
          {' · '}
          本局已标 <strong>{labeled}</strong>
          {canLabel ? '' : ' · 还不是 SMR 四类头'}
        </p>
        {saved ? (
          <p className="muted text-sm">
            上次 {saved.subjectId}：{proficientSummary(saved.scores)}
          </p>
        ) : null}
        <p className="mb-0 text-sm">
          离线再训：<code>npm run model-service:reve:smr:fit</code>，会读
          recordings/*smr-adapt* 里的 trial / smr_window。评分头请去{' '}
          <Link to="/online-learn">基模在线学习</Link>。
        </p>
      </Panel>

      <Panel title="模型连接">
        <p className="muted mt-0 mb-3 text-sm">
          本页会拉起 smr_control。开始适配后自动录制；结束后自动停录并保留 bin。
        </p>
        <ModelServicePanel embedded reveTask="smr_control" />
      </Panel>
    </div>
  )
}
