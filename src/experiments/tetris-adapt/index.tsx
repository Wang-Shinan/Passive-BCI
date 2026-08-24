import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { SessionLogger } from '../../lib/logger'
import {
  ModelServicePanel,
  TETRIS_LIVE_STEP_SEC,
  TemporalFilterControls,
  ensureModelService,
  modelRuntimeHub,
  modelServiceStatus,
  reveLiveHopMatches,
  useModelRuntime,
  useTemporalFilter,
} from '../../lib/model-runtime'
import { mulberry32, randomSeed } from '../../lib/rng'
import {
  startExperimentRecording,
  stopExperimentRecording,
} from '../../lib/session/recordControl'
import { ExportButtons, loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import { BOARD_DEFAULT_CELL, NextPreview, useBoardCell } from '../tetris/Board'
import type { Piece } from '../tetris/engine'
import { SMR_TICK_SEC, resolveLaplacianMontage } from '../smr-adapt/smrControl'
import { AdaptBoard } from './AdaptBoard'
import {
  CUE_SEC,
  ITI_SEC,
  OVERLAP_FEEDBACK_SEC,
  FEET_CLASS_NAME,
  FEET_INTENDED_ACTION,
  PLANS,
  POST_SEC,
  advancePhase,
  createSession,
  cueLabel,
  currentTrial,
  finishTrial,
  instructionFor,
  overallHitRate,
  patchTrial,
  phaseDuration,
  planTrialTotal,
  scoresByBlock,
  startSession,
  type PlanId,
  type SessionState,
  type TrialRecord,
} from './engine'
import {
  applyOverlapAction,
  overlapHit,
  poseLogFrom,
  spawnOverlapTrial,
  subjectLanding,
  type MiniState,
} from './miniBoard'
import { laplacianFeatures } from './smrDrive'
import {
  describeOverlapAction,
  overlapActionFromAxes,
  overlapActionFromClassName,
  axesFromReve,
  type CursorDrive,
  type OverlapAction,
} from './smrMap'
import {
  applyTask1Action,
  demoTask1Action,
  idleWell,
  occupiedCells,
  spawnTask1Trial,
  spawnFeetTrial,
  task1Hit,
  tickTask1Gravity,
  type Task1State,
} from './task1Well'
import './tetris-adapt.css'

const CURSOR_DRIVE_KEY = 'passive-bci.tetris-adapt-cursor-drive'
const OVERLAP_MOVE_MS = 400

type Welford = { n: number; mean: number; m2: number }

function loadCursorDrive(): CursorDrive {
  if (typeof window === 'undefined') return 'reve'
  return window.localStorage.getItem(CURSOR_DRIVE_KEY) === 'features' ? 'features' : 'reve'
}

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

function demoOverlapAction(state: MiniState): OverlapAction | null {
  if (Math.random() < 0.2) return null
  const red = subjectLanding(state)
  if (red.rot !== state.teacher.rot) return 'rotate'
  if (red.x < state.teacher.x) return 'right'
  if (red.x > state.teacher.x) return 'left'
  return null
}

function poseFromPiece(piece: Piece) {
  return { x: piece.x, y: piece.y, rot: piece.rot, cells: occupiedCells(piece) }
}

export function TetrisAdaptPage() {
  const [subjectId, setSubjectId] = useState(() => loadStoredSubjectId('S01'))
  const [planId, setPlanId] = useState<PlanId>('quick')
  const [session, setSession] = useState<SessionState>(() =>
    createSession(PLANS.quick, randomSeed()),
  )
  const [task1, setTask1] = useState<Task1State | null>(null)
  const [mini, setMini] = useState<MiniState | null>(null)
  const [notice, setNotice] = useState('')
  const [cursorDrive, setCursorDrive] = useState<CursorDrive>(loadCursorDrive)
  const { config: temporalConfig, setConfig: setTemporalConfig, filterRef: temporalFilterRef } =
    useTemporalFilter(TETRIS_LIVE_STEP_SEC)
  const [lastAction, setLastAction] = useState('—')
  const [boardCell, setBoardCell] = useBoardCell()
  const loggerRef = useRef(new SessionLogger('tetris-adapt', subjectId))
  const sessionRef = useRef(session)
  const task1Ref = useRef<Task1State | null>(null)
  const miniRef = useRef<MiniState | null>(null)
  const warmupH = useRef<Welford>({ n: 0, mean: 0, m2: 0 })
  const warmupV = useRef<Welford>({ n: 0, mean: 0, m2: 0 })
  const cursorDriveRef = useRef(cursorDrive)
  const overlapBagRef = useRef<MiniState['bag']>([])
  const overlapRngRef = useRef(mulberry32(1))
  const lastMoveAtRef = useRef(0)
  const lastObsRef = useRef<string | null>(null)
  const idleGame = useMemo(() => idleWell(1), [])
  const runtime = useModelRuntime()
  const eeg = useLiveEeg()

  sessionRef.current = session
  task1Ref.current = task1
  miniRef.current = mini
  cursorDriveRef.current = cursorDrive

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    window.localStorage.setItem(CURSOR_DRIVE_KEY, cursorDrive)
  }, [cursorDrive])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const status = await modelServiceStatus(ac.signal)
        if (ac.signal.aborted) return
        if (status.running && status.task === 'smr_control') {
          const hopOk = reveLiveHopMatches(status.stepSec, TETRIS_LIVE_STEP_SEC)
          if (hopOk) {
            modelRuntimeHub.setEnabled(true)
            modelRuntimeHub.connect()
            if (status.owned || cursorDrive !== 'reve') return
          }
        }
        if (cursorDrive !== 'reve') return
        setNotice('正在启动 REVE SMR 头（首次加载权重可能要一两分钟）…')
        const result = await ensureModelService({
          backend: 'reve',
          task: 'smr_control',
          stepSec: TETRIS_LIVE_STEP_SEC,
          force: Boolean(
            status.running &&
              (!status.owned ||
                status.task !== 'smr_control' ||
                !reveLiveHopMatches(status.stepSec, TETRIS_LIVE_STEP_SEC)),
          ),
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
  }, [cursorDrive])

  const montage = useMemo(
    () => resolveLaplacianMontage(eeg.meta.channelNames),
    [eeg.meta.channelNames],
  )
  const live = eeg.live
  const trial = currentTrial(session)
  const running = session.phase !== 'idle' && session.phase !== 'done'
  const scores = useMemo(() => scoresByBlock(session.trials), [session.trials])
  const hitRate = useMemo(() => overallHitRate(session.trials), [session.trials])

  const startRound = async () => {
    warmupH.current = { n: 0, mean: 0, m2: 0 }
    warmupV.current = { n: 0, mean: 0, m2: 0 }
    overlapBagRef.current = []
    lastMoveAtRef.current = 0
    lastObsRef.current = null
    temporalFilterRef.current.reset()
    setLastAction('—')
    setMini(null)
    setTask1(null)
    const seed = randomSeed()
    overlapRngRef.current = mulberry32(seed ^ 0x9e3779b9)
    loggerRef.current.clear()
    const notes: string[] = []
    if (live) {
      const rec = await startExperimentRecording({
        experiment: 'tetris-adapt',
        subjectId,
        seed,
      })
      notes.push(rec.message)
    } else {
      notes.push('未开流，使用演示驱动（不写 REVE / 不落盘）')
    }
    const next = startSession(createSession(PLANS[planId], seed, performance.now()), performance.now())
    setSession(next)
    loggerRef.current.log('session_start', {
      planId,
      seed: next.seed,
      trials: next.trials.length,
      live,
      cursorDrive,
      collect: { className: FEET_CLASS_NAME, intendedAction: FEET_INTENDED_ACTION, control: false },
      montage: montage
        ? { c3: montage.neighborNamesC3, c4: montage.neighborNamesC4 }
        : null,
    })
    setNotice(
      live
        ? cursorDrive === 'features'
          ? `C3/C4 mu 驱动。SMR 头冻结，不在线微调。${notes.filter(Boolean).join(' ')}`
          : `REVE 驱动；SMR 头冻结，不在线微调。${notes.filter(Boolean).join(' ')}`
        : notes.join(' '),
    )
  }

  const resolveAxes = useCallback((): { zH: number; zV: number } | null => {
    const useReve = cursorDriveRef.current === 'reve'
    const pred = useReve && live ? modelRuntimeHub.latestObservation(2500) : null
    if (pred) {
      const decision = temporalFilterRef.current.observePrediction(pred)
      return axesFromReve(decision.classNames, decision.probabilities)
    }
    if (live && montage) {
      const raw = laplacianFeatures(montage)
      if (!raw) return null
      pushWelford(warmupH.current, raw.horiz)
      pushWelford(warmupV.current, raw.vert)
      return { zH: zWelford(warmupH.current, raw.horiz), zV: zWelford(warmupV.current, raw.vert) }
    }
    return null
  }, [live, montage])

  const attachOverlap = useCallback((state: SessionState, item: TrialRecord): SessionState => {
    if (item.kind !== 'overlap' || !item.boardWidth) return state
    const nextMini = spawnOverlapTrial(item.boardWidth, overlapRngRef.current, overlapBagRef.current)
    overlapBagRef.current = nextMini.bag
    miniRef.current = nextMini
    setMini(nextMini)
    setTask1(null)
    task1Ref.current = null
    const teacher = poseLogFrom(nextMini.teacher)
    const subject = poseLogFrom(subjectLanding(nextMini))
    loggerRef.current.log('piece_spawn', {
      index: item.index,
      pieceType: nextMini.subject.type,
      boardWidth: item.boardWidth,
      teacher,
      subject,
    })
    return patchTrial(state, item.index, {
      pieceType: nextMini.subject.type,
      teacher,
      subject,
    })
  }, [])

  const attachTask1 = useCallback((state: SessionState, item: TrialRecord): SessionState => {
    if (item.kind !== 'smr' || !item.task || !item.target) return state
    const nextWell = spawnTask1Trial(item.task, item.target, state.seed + item.index * 997)
    task1Ref.current = nextWell
    setTask1(nextWell)
    setMini(null)
    miniRef.current = null
    const piece = nextWell.game.piece
    const teacher = nextWell.teacher ? poseFromPiece(nextWell.teacher) : undefined
    const subject = piece ? poseFromPiece(piece) : undefined
    loggerRef.current.log('piece_spawn', {
      index: item.index,
      kind: 'smr',
      task: item.task,
      target: item.target,
      className: item.className,
      control: true,
      cue: nextWell.cue,
      pieceType: piece?.type,
      teacher,
      subject,
    })
    return patchTrial(state, item.index, {
      pieceType: piece?.type,
      teacher,
      subject,
    })
  }, [])

  const attachCollect = useCallback((state: SessionState, item: TrialRecord): SessionState => {
    if (item.kind !== 'collect') return state
    const nextWell = spawnFeetTrial(state.seed + item.index * 997)
    task1Ref.current = nextWell
    setTask1(nextWell)
    setMini(null)
    miniRef.current = null
    const piece = nextWell.game.piece
    const teacher = nextWell.teacher ? poseFromPiece(nextWell.teacher) : undefined
    const subject = piece ? poseFromPiece(piece) : undefined
    loggerRef.current.log('piece_spawn', {
      index: item.index,
      kind: 'collect',
      className: item.className ?? FEET_CLASS_NAME,
      intendedAction: item.intendedAction ?? FEET_INTENDED_ACTION,
      control: false,
      cue: nextWell.cue,
      pieceType: piece?.type,
      teacher,
      subject,
    })
    return patchTrial(state, item.index, {
      pieceType: piece?.type,
      teacher,
      subject,
    })
  }, [])

  const completeOverlap = useCallback(
    (outcome: 'hit' | 'timeout', elapsed: number, now: number, currentMini: MiniState) => {
      const current = sessionRef.current
      const item = currentTrial(current)
      if (!item || current.phase !== 'feedback') return
      const teacher = poseLogFrom(currentMini.teacher)
      const subject = poseLogFrom(subjectLanding(currentMini))
      const next = finishTrial(current, outcome, null, elapsed, now, {
        pieceType: currentMini.subject.type,
        teacher,
        subject,
      })
      sessionRef.current = next
      setSession(next)
      if (outcome === 'hit') {
        loggerRef.current.log('overlap_hit', {
          index: item.index,
          pieceType: currentMini.subject.type,
          boardWidth: item.boardWidth,
          teacher,
          subject,
          feedbackSec: elapsed,
        })
      }
      loggerRef.current.log('trial', {
        index: item.index,
        kind: 'overlap',
        boardWidth: item.boardWidth,
        pieceType: currentMini.subject.type,
        teacher,
        subject,
        outcome,
        feedbackSec: elapsed,
      })
    },
    [],
  )

  const completeTask1 = useCallback(
    (outcome: 'hit' | 'timeout', elapsed: number, now: number, well: Task1State) => {
      const current = sessionRef.current
      const item = currentTrial(current)
      if (!item || current.phase !== 'feedback') return
      const piece = well.game.piece
      const teacher = well.teacher ? poseFromPiece(well.teacher) : undefined
      const subject = piece ? poseFromPiece(piece) : undefined
      const next = finishTrial(current, outcome, outcome === 'hit' ? item.target ?? null : null, elapsed, now, {
        pieceType: piece?.type,
        teacher,
        subject,
      })
      sessionRef.current = next
      setSession(next)
      loggerRef.current.log('trial', {
        index: item.index,
        kind: 'smr',
        task: item.task,
        target: item.target,
        className: item.className,
        control: true,
        cue: well.cue,
        pieceType: piece?.type,
        teacher,
        subject,
        outcome,
        hit: outcome === 'hit' ? item.target : null,
        feedbackSec: elapsed,
      })
    },
    [],
  )

  const completeCollect = useCallback(
    (elapsed: number, now: number, well: Task1State) => {
      const current = sessionRef.current
      const item = currentTrial(current)
      if (!item || current.phase !== 'feedback' || item.kind !== 'collect') return
      const piece = well.game.piece
      const teacher = well.teacher ? poseFromPiece(well.teacher) : undefined
      const subject = piece ? poseFromPiece(piece) : undefined
      const next = finishTrial(current, 'recorded', null, elapsed, now, {
        pieceType: piece?.type,
        teacher,
        subject,
      })
      sessionRef.current = next
      setSession(next)
      loggerRef.current.log('trial', {
        index: item.index,
        kind: 'collect',
        className: item.className ?? FEET_CLASS_NAME,
        intendedAction: item.intendedAction ?? FEET_INTENDED_ACTION,
        control: false,
        cue: well.cue,
        pieceType: piece?.type,
        teacher,
        subject,
        outcome: 'recorded',
        feedbackSec: elapsed,
      })
    },
    [],
  )

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      const now = performance.now()
      const current = sessionRef.current
      const elapsed = (now - current.phaseStartedAt) / 1000
      const item = currentTrial(current)

      if (current.phase === 'iti' && elapsed >= ITI_SEC) {
        let next = advancePhase(current, now)
        const nextTrial = currentTrial(next)
        if (nextTrial?.kind === 'overlap') {
          next = attachOverlap(next, nextTrial)
        } else if (nextTrial?.kind === 'smr') {
          next = attachTask1(next, nextTrial)
          loggerRef.current.log('cue', {
            target: nextTrial.target,
            task: nextTrial.task,
            className: nextTrial.className,
            control: true,
            cue: cueLabel(nextTrial),
          })
        } else if (nextTrial?.kind === 'collect') {
          next = attachCollect(next, nextTrial)
          loggerRef.current.log('cue', {
            className: nextTrial.className ?? FEET_CLASS_NAME,
            intendedAction: nextTrial.intendedAction ?? FEET_INTENDED_ACTION,
            control: false,
            cue: cueLabel(nextTrial),
          })
        } else {
          setMini(null)
          setTask1(null)
          miniRef.current = null
          task1Ref.current = null
        }
        sessionRef.current = next
        setSession(next)
        return
      }
      if (current.phase === 'cue' && elapsed >= CUE_SEC) {
        const next = advancePhase(current, now)
        sessionRef.current = next
        setSession(next)
        lastMoveAtRef.current = 0
        lastObsRef.current = null
        return
      }
      if (current.phase === 'post' && elapsed >= POST_SEC) {
        const next = advancePhase(current, now)
        sessionRef.current = next
        setSession(next)
        if (next.phase === 'done') {
          setMini(null)
          setTask1(null)
          miniRef.current = null
          task1Ref.current = null
          void stopExperimentRecording().then((result) => {
            if (result.message) setNotice(result.message)
          })
        }
        return
      }
      if (current.phase !== 'feedback' || !item) return

      if (item.kind === 'collect') {
        const well = task1Ref.current
        if (!well) return
        if (elapsed >= phaseDuration('feedback', item)) {
          completeCollect(elapsed, now, well)
        }
        return
      }

      if (item.kind === 'smr') {
        const well = task1Ref.current
        if (!well) return
        const fallen = tickTask1Gravity(well, SMR_TICK_SEC)
        task1Ref.current = fallen
        setTask1(fallen)
        const limit = phaseDuration('feedback', item)
        if (task1Hit(fallen)) {
          completeTask1('hit', elapsed, now, fallen)
          return
        }
        if (elapsed >= limit) {
          completeTask1('timeout', elapsed, now, fallen)
          return
        }

        const useReve = cursorDriveRef.current === 'reve'
        const pred = useReve && live ? modelRuntimeHub.latestObservation(2500) : null
        let action: OverlapAction | null = null
        if (pred) {
          if (pred.observation_id === lastObsRef.current) return
          lastObsRef.current = pred.observation_id
          action = overlapActionFromClassName(temporalFilterRef.current.observePrediction(pred).className)
        } else {
          if (now - lastMoveAtRef.current < OVERLAP_MOVE_MS) return
          const axes = resolveAxes()
          action = axes ? overlapActionFromAxes(axes.zH, axes.zV) : demoTask1Action(fallen)
        }
        if (!action) return
        lastMoveAtRef.current = now
        const moved = applyTask1Action(fallen, action)
        task1Ref.current = moved
        setTask1(moved)
        setLastAction(describeOverlapAction(action))
        if (task1Hit(moved)) completeTask1('hit', elapsed, now, moved)
        return
      }

      if (item.kind !== 'overlap') return
      const board = miniRef.current
      if (!board) return
      if (overlapHit(board)) {
        completeOverlap('hit', elapsed, now, board)
        return
      }
      if (elapsed >= OVERLAP_FEEDBACK_SEC) {
        completeOverlap('timeout', elapsed, now, board)
        return
      }

      const useReve = cursorDriveRef.current === 'reve'
      const pred = useReve && live ? modelRuntimeHub.latestObservation(2500) : null
      let action: OverlapAction | null = null
      if (pred) {
        if (pred.observation_id === lastObsRef.current) return
        lastObsRef.current = pred.observation_id
        action = overlapActionFromClassName(temporalFilterRef.current.observePrediction(pred).className)
      } else {
        if (now - lastMoveAtRef.current < OVERLAP_MOVE_MS) return
        const axes = resolveAxes()
        action = axes ? overlapActionFromAxes(axes.zH, axes.zV) : demoOverlapAction(board)
      }
      if (!action || action === 'down') return
      lastMoveAtRef.current = now
      const moved = applyOverlapAction(board, action)
      miniRef.current = moved
      setMini(moved)
      setLastAction(describeOverlapAction(action))
      if (overlapHit(moved)) completeOverlap('hit', elapsed, now, moved)
    }, Math.round(SMR_TICK_SEC * 1000))
    return () => window.clearInterval(id)
  }, [running, live, resolveAxes, attachOverlap, attachTask1, attachCollect, completeOverlap, completeTask1, completeCollect])

  useEffect(() => {
    if (!running) return
    const onKey = (event: KeyboardEvent) => {
      const current = sessionRef.current
      const item = currentTrial(current)
      if (current.phase !== 'feedback' || !item || item.kind === 'collect') return
      let action: OverlapAction | null = null
      if (event.key === 'ArrowLeft') action = 'left'
      else if (event.key === 'ArrowRight') action = 'right'
      else if (event.key === 'ArrowUp' || event.key === 'x' || event.key === 'X') action = 'rotate'
      else if (event.key === 'ArrowDown' || event.key === ' ') action = 'down'
      if (!action) return
      event.preventDefault()
      const now = performance.now()
      const elapsed = (now - current.phaseStartedAt) / 1000

      if (item.kind === 'smr') {
        const well = task1Ref.current
        if (!well) return
        const moved = applyTask1Action(well, action)
        task1Ref.current = moved
        setTask1(moved)
        setLastAction(describeOverlapAction(action))
        if (task1Hit(moved)) completeTask1('hit', elapsed, now, moved)
        return
      }

      if (item.kind !== 'overlap') return
      const board = miniRef.current
      if (!board) return
      if (action === 'down') {
        if (overlapHit(board)) completeOverlap('hit', elapsed, now, board)
        return
      }
      const moved = applyOverlapAction(board, action)
      miniRef.current = moved
      setMini(moved)
      setLastAction(describeOverlapAction(action))
      if (overlapHit(moved)) completeOverlap('hit', elapsed, now, moved)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, completeOverlap, completeTask1])

  const flash: 'hit' | 'miss' | null =
    session.phase === 'post' && trial?.outcome === 'hit'
      ? 'hit'
      : session.phase === 'post' && trial?.outcome && trial.outcome !== 'recorded'
        ? 'miss'
        : null

  const overlay =
    session.phase === 'done'
      ? `完成。命中率 ${hitRate == null ? '—' : `${(hitRate * 100).toFixed(0)}%`}`
      : session.phase === 'iti'
        ? trial
          ? `准备 · ${instructionFor(trial)}`
          : '准备'
        : session.phase === 'cue' && trial
          ? cueLabel(trial)
          : session.phase === 'idle'
            ? instructionFor(null)
            : null

  const showMini =
    trial?.kind === 'overlap' &&
    (session.phase === 'cue' || session.phase === 'feedback' || session.phase === 'post')
  const showTask1 =
    (trial?.kind === 'smr' || trial?.kind === 'collect') &&
    (session.phase === 'cue' || session.phase === 'feedback' || session.phase === 'post')

  const boardTitle =
    trial?.kind === 'overlap'
      ? '落点重叠'
      : trial?.kind === 'collect'
        ? '脚想象 · 速降'
        : trial?.kind === 'smr' && trial.task === 'UD'
          ? '旋转 / 下落'
          : trial?.kind === 'smr'
            ? '左移 / 右移'
            : '俄罗斯方块'

  const nextType = showTask1 ? task1?.game.next : null
  /** Task 2 uses the same cell px as default 10×20 `/tetris`; never scale down by column count. */
  const wellCell = showMini ? BOARD_DEFAULT_CELL : boardCell

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-[var(--text)]">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-2 text-2xl font-semibold tracking-tight">方块 SMR 适配</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            完整井里先练左移、右移、旋转、下落，再采脚想象（速降，只打标签不控方块），然后在宽 5 / 宽 7 窄井上把红色落点叠到教师绿影。
            左手← 右手→ 双手↻ 休息↓ 双脚速降。SMR 头仍是四分类，脚想象先只录 EEG。
            {' · '}
            <Link to="/tetris" className="hover:text-[var(--text)]">
              去调试/对局页
            </Link>
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <LiveEegBadge />
          <ExportButtons
            logger={loggerRef.current}
            subjectId={subjectId}
            onSubjectChange={setSubjectId}
            experiment="tetris-adapt"
            recordControl
          />
        </div>
      </header>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="relative w-fit self-center xl:self-start">
          <AdaptBoard
            task1={showTask1 ? task1 : null}
            mini={showMini ? mini : null}
            idleGame={showTask1 || showMini ? null : idleGame}
            overlay={session.phase === 'feedback' ? null : overlay}
            flash={flash}
            cell={wellCell}
          />
          {showMini ? (
            <p className="ta-legend">
              <span>
                <i className="is-red" />
                红框：你的预测落点
              </span>
              <span>
                <i className="is-green" />
                绿框：教师目标（自动转角）
              </span>
            </p>
          ) : showTask1 && task1 ? (
            <p className="ta-legend">
              {task1.cue === 'left' || task1.cue === 'right' ? (
                <span>
                  <i className="is-gold" />
                  高亮列：目标墙侧
                </span>
              ) : (
                <span>
                  <i className="is-green" />
                  {task1.cue === 'rotate'
                    ? '绿影：目标朝向'
                    : task1.cue === 'hardDrop'
                      ? '绿影：速降落点（本轮不控方块）'
                      : '绿影：目标落点'}
                </span>
              )}
            </p>
          ) : null}
          <p className="muted mb-0 mt-3 text-sm">
            {trial ? instructionFor(trial) : '选择计划后开始。把活块移到左侧/右侧，或旋转、下落对齐。'}
            {running ? ` 最近动作 ${lastAction}` : ''}
          </p>
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <Panel
            title={boardTitle}
            actions={
              <span className="muted text-xs">
                {trial
                  ? `${
                      trial.kind === 'collect'
                        ? '脚想象'
                        : trial.kind === 'smr'
                          ? trial.task
                          : `宽 ${trial.boardWidth}`
                    } · ${trial.index + 1}/${session.trials.length}`
                  : session.plan.label}
              </span>
            }
          >
            {nextType ? (
              <div className="mb-3 flex items-center gap-3">
                <div>
                  <div className="muted mb-1 text-xs">下一块</div>
                  <NextPreview type={nextType} />
                </div>
                <div className="muted text-sm">
                  {trial?.kind === 'collect'
                    ? '本轮只想象双脚蹬踏，键盘 / SMR 都不控方块。'
                    : '←→ 左移/右移 · ↑/X 旋转 · ↓/空格 下落'}
                  <button
                    type="button"
                    className="btn ml-2"
                    onClick={() => setBoardCell((c) => (c >= 36 ? 24 : c + 4))}
                  >
                    棋盘 {wellCell}px
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted mt-0 text-sm">←→ 左移/右移 · ↑/X 旋转 · ↓ 确认重叠</p>
            )}
          </Panel>

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
                    setMini(null)
                    setTask1(null)
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
            <p className="muted mt-0 text-sm">
              {PLANS[planId].hint}（共 {planTrialTotal(PLANS[planId])} 试次）
            </p>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="muted text-sm">SMR 驱动</span>
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
              <div className="mb-3">
                <TemporalFilterControls config={temporalConfig} onChange={setTemporalConfig} compact />
              </div>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={running} onClick={() => void startRound()}>
              {session.phase === 'done' ? '再做一轮' : '开始适配'}
            </button>
            {notice ? <p className="muted mb-0 mt-3 text-sm">{notice}</p> : null}
            {!montage && live && cursorDrive === 'features' ? (
              <p className="mb-0 mt-3 text-sm" style={{ color: 'var(--danger)' }}>
                当前导联没有 C3/C4，无法计算 mu 控制律。
              </p>
            ) : null}
          </Panel>

          <Panel title="本轮">
            {scores.length === 0 ? (
              <p className="muted mb-0 text-sm">还没有完成的试次。</p>
            ) : (
              <ul className="m-0 list-none space-y-2 p-0 text-sm">
                {scores.map((row) => (
                  <li key={row.key}>
                    <strong>{row.label}</strong>{' '}
                    {row.recorded > 0 && row.rate == null
                      ? `已采 ${row.recorded} 段`
                      : `${row.rate == null ? '—' : `${(row.rate * 100).toFixed(0)}%`}`}
                    <span className="muted">
                      {row.recorded > 0 && row.rate == null
                        ? ' · 只打标签，不控方块'
                        : ` · ${row.hits} 中 / ${row.misses} 错 / ${row.timeouts} 超时`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted mb-0 mt-3 text-sm">
              {hitRate == null
                ? '左移/右移：贴到目标墙侧为命中。旋转：朝向与绿影一致。下落：落到标记落点。脚想象：双脚蹬踏对应速降，本轮只录标签。重叠：红绿格子完全重合。'
                : `总命中率 ${(hitRate * 100).toFixed(0)}%。`}
            </p>
          </Panel>
        </div>
      </div>

      <Panel title="基模连接 + 离线落盘" className="mt-4 mb-4">
        <p className="muted mt-0 text-sm">
          {cursorDrive === 'features'
            ? '按 C3/C4 Laplacian mu 驱动方块。没有特征时演示会自己靠近目标。SMR 头冻结，本页不向 REVE 打标签。'
            : '由已拟合的 REVE 四分类驱动（左← 右→ 双手↻ 休息↓）。脚想象（feet → 速降）只写入 events，不进控制。没有预测时回退 C3/C4 mu。SMR 头冻结，不在线微调。'}
        </p>
        <p className="text-sm">
          当前预测 <strong>{runtime.latestPrediction?.class_name ?? '—'}</strong>
          {' · '}
          策略 <strong>{runtime.serviceHello?.strategy ?? '—'}</strong>
        </p>
        <p className="mb-0 text-sm">
          开流后点开始会自动录 EEG + trial / piece_spawn / overlap_hit。脚想象试次会打 className=feet、intendedAction=hardDrop。三类任务头请去{' '}
          <Link to="/online-learn">基模在线学习</Link>
          ，SMR 光标练习也可去 <Link to="/smr-adapt">SMR 个体化适配</Link>。
        </p>
      </Panel>

      <Panel title="模型连接">
        <p className="muted mt-0 mb-3 text-sm">
          {cursorDrive === 'reve'
            ? '当前会拉起冻结的 smr_control（strategy=none，在线 0.1s 步）。开始适配后自动录制；结束后自动停录。'
            : '特征驱动不自动拉起 REVE。需要 REVE 驱动时再在下面启动 smr_control。开始适配后自动录制。'}
        </p>
        <ModelServicePanel embedded reveTask="smr_control" liveStepSec={TETRIS_LIVE_STEP_SEC} />
      </Panel>
    </div>
  )
}
