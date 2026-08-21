import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { sessionHub } from '../../lib/session/sessionHub'
import { mulberry32 } from '../../lib/rng'
import { ManualSignalSource } from '../../lib/signal/manual'
import { ExportButtons, loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { LineChart } from '../../lib/ui/LineChart'
import { ColumnResizer } from '../../lib/ui/ColumnResizer'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import { BOARD_DEFAULT_CELL, Board, NextPreview, useBoardCell } from './Board'
import { tetrisContextSnapshot, type TetrisControlSource } from './boardFeatures'
import {
  COLS,
  advanceBoardAnim,
  advanceFall,
  collides,
  createGame,
  hardDrop,
  holdOrLock,
  move,
  rotate,
  softDropBurst,
  type GameEvent,
  type GameState,
} from './engine'
import {
  defaultGravityConfig,
  initGravityState,
  updateGravity,
  type GravityConfig,
  type GravityMode,
  type GravityState,
} from './gravity'
import { FeatureMonitorPanel, SignalModeControls, useStressControl } from '../../lib/features'
import { ModelServicePanel } from '../../lib/model-runtime/ModelServicePanel'
import { ensureModelService, modelServiceStatus } from '../../lib/model-runtime/modelServiceApi'
import { modelRuntimeHub } from '../../lib/model-runtime/modelRuntimeHub'
import { useModelRuntime } from '../../lib/model-runtime/useModelRuntime'
import { RlAgentPanel } from './RlAgentPanel'
import { StressPanel } from './StressPanel'
import {
  applyTeacherFollow,
  clampFollowMoves,
  clampFollowSteps,
  describeCollabDecision,
  executeMiInCollab,
  followPieceKey,
  noteFollowHumanMove,
  collabTeacherDecision,
  FOLLOW_LOCK_DELAY_MS,
  FOLLOW_MOVES_DEFAULT,
  FOLLOW_STEPS_DEFAULT,
} from './collab'
import {
  applyMiControlAction,
  describeMiControlAction,
  isSmrControlPrediction,
  miControlActionForClassName,
  miControlActionForPrediction,
} from './miControl'
import { RL_DECISION_INTERVAL_MS } from './rl/contracts'
import { HeuristicPlanner } from './rl/heuristic'
import { describeRlAction, applyRlAction, rlStep } from './rl/step'
import { useStressBroadcast } from './useStressBroadcast'

const MI_CONTROL_KEY = 'passive-bci.tetris-mi-control'
const RL_CONTROL_KEY = 'passive-bci.tetris-rl-control'
const COLLAB_CONTROL_KEY = 'passive-bci.tetris-collab-control'
const FOLLOW_CONTROL_KEY = 'passive-bci.tetris-follow-control'
const FOLLOW_MOVES_KEY = 'passive-bci.tetris-follow-moves'
const FOLLOW_STEPS_KEY = 'passive-bci.tetris-follow-steps'
const RIGHT_COL_KEY = 'passive-bci.tetris-right-col'
const RIGHT_COL_DEFAULT = 320
const RIGHT_COL_MIN = 260
const RIGHT_COL_MAX = 620
const MID_COL_MIN = 340

function loadMiControlEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(MI_CONTROL_KEY) === 'true'
}

function loadRlControlEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(RL_CONTROL_KEY) === 'true'
}

function loadCollabControlEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(COLLAB_CONTROL_KEY) === 'true'
}

function loadFollowControlEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(FOLLOW_CONTROL_KEY) === 'true'
}

function loadFollowMoves(): number {
  if (typeof localStorage === 'undefined') return FOLLOW_MOVES_DEFAULT
  return clampFollowMoves(Number(localStorage.getItem(FOLLOW_MOVES_KEY)))
}

function loadFollowSteps(): number {
  if (typeof localStorage === 'undefined') return FOLLOW_STEPS_DEFAULT
  return clampFollowSteps(Number(localStorage.getItem(FOLLOW_STEPS_KEY)))
}

function clampRightCol(value: number): number {
  return Math.min(RIGHT_COL_MAX, Math.max(RIGHT_COL_MIN, Math.round(value)))
}

function loadRightCol(): number {
  if (typeof localStorage === 'undefined') return RIGHT_COL_DEFAULT
  const raw = Number(localStorage.getItem(RIGHT_COL_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampRightCol(raw) : RIGHT_COL_DEFAULT
}

interface TracePoint {
  t: number
  stress: number
  gravity: number
}

export function TetrisExperiment() {
  const [subjectId, setSubjectId] = useState(() => loadStoredSubjectId('S01'))
  const [seed] = useState(() => (Math.random() * 0xffffffff) >>> 0)
  const seedRef = useRef(seed)
  const rngRef = useRef(mulberry32(seed))
  const [state, setState] = useState<GameState>(() => createGame(seed))
  const {
    mode,
    setMode,
    driverFeature,
    setDriverFeature,
    rangeMap,
    setRangeMap,
    resetRangeMap,
    captureRangeFromWindow,
    rangePreview,
    stress,
    setStress,
    takeManualControl,
    setManualStressQuiet,
    features,
  } = useStressControl({
    initial: 40,
    manualModulators: (s) => ({
      stress: s,
      focus: 100 - s * 0.35,
      arousal: s * 0.7 + 20,
    }),
  })
  useStressBroadcast(stress, { mode, takeManualControl, setManualStressQuiet })
  const modelRuntime = useModelRuntime()
  const [miControlEnabled, setMiControlEnabled] = useState(
    () => loadMiControlEnabled() || loadCollabControlEnabled() || loadFollowControlEnabled(),
  )
  const lastMiObservationRef = useRef<string | null>(null)
  const [lastMiAction, setLastMiAction] = useState<string>('—')
  const [smrEnsureError, setSmrEnsureError] = useState('')
  const [smrEnsuring, setSmrEnsuring] = useState(false)
  const teacherRef = useRef(new HeuristicPlanner())
  const [rlEnabled, setRlEnabled] = useState(
    () => loadRlControlEnabled() && !loadCollabControlEnabled() && !loadFollowControlEnabled(),
  )
  const [collabEnabled, setCollabEnabled] = useState(
    () => loadCollabControlEnabled() && !loadFollowControlEnabled(),
  )
  const [followEnabled, setFollowEnabled] = useState(loadFollowControlEnabled)
  const [followMoves, setFollowMoves] = useState(loadFollowMoves)
  const [followSteps, setFollowSteps] = useState(loadFollowSteps)
  const [followHumanCount, setFollowHumanCount] = useState(0)
  const followMovesRef = useRef(followMoves)
  const followStepsRef = useRef(followSteps)
  const followHumanCountRef = useRef(0)
  const followPieceKeyRef = useRef<string | null>(null)
  followMovesRef.current = followMoves
  followStepsRef.current = followSteps
  followHumanCountRef.current = followHumanCount
  const [lastRlAction, setLastRlAction] = useState('—')
  const [rlLatencyMs, setRlLatencyMs] = useState<number | null>(null)
  const rlDecisionAccRef = useRef(0)
  const rlBusyRef = useRef(false)
  const rlAutoRestartRef = useRef<number | null>(null)
  const [cfg, setCfg] = useState<GravityConfig>(() => defaultGravityConfig())
  const gravityRef = useRef<GravityState>(initGravityState(defaultGravityConfig()))
  const [gravityDisplay, setGravityDisplay] = useState(gravityRef.current.smoothed)
  const [trace, setTrace] = useState<TracePoint[]>([])
  const [cascadeFlash, setCascadeFlash] = useState<string | null>(null)
  const loggerRef = useRef(new SessionLogger('tetris', subjectId))
  const signalRef = useRef(new ManualSignalSource({ kind: 'stress', initial: 40 }))
  const lastTsRef = useRef(0)
  const t0Ref = useRef(performance.now())
  const stateRef = useRef(state)
  const stressRef = useRef(stress)
  const cfgRef = useRef(cfg)
  const softDropHeldRef = useRef(false)
  const traceAccRef = useRef(0)
  const controlRef = useRef<TetrisControlSource>('human')

  const [boardCell, setBoardCell] = useBoardCell()
  const [rightCol, setRightCol] = useState(loadRightCol)
  const midColRef = useRef<HTMLDivElement | null>(null)
  const dragBase = useRef({ cell: 0, right: 0, midWidth: 0 })

  useEffect(() => {
    localStorage.setItem(RIGHT_COL_KEY, String(rightCol))
  }, [rightCol])

  // Give up right-column width first when the viewport can no longer fit the middle column.
  useEffect(() => {
    const mid = midColRef.current
    if (!mid || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const deficit = MID_COL_MIN - mid.offsetWidth
      if (deficit > 0) setRightCol((current) => Math.max(RIGHT_COL_MIN, current - deficit))
    })
    observer.observe(mid)
    return () => observer.disconnect()
  }, [])

  const beginColumnDrag = useCallback(() => {
    dragBase.current = {
      cell: boardCell,
      right: rightCol,
      midWidth: midColRef.current?.offsetWidth ?? MID_COL_MIN,
    }
  }, [boardCell, rightCol])

  const dragBoardColumn = useCallback(
    (dx: number) => {
      const { cell, midWidth } = dragBase.current
      const slack = Math.max(0, midWidth - MID_COL_MIN)
      setBoardCell(Math.min(cell + dx / COLS, cell + slack / COLS))
    },
    [setBoardCell],
  )

  const dragRightColumn = useCallback((dx: number) => {
    const { right, midWidth } = dragBase.current
    const slack = Math.max(0, midWidth - MID_COL_MIN)
    setRightCol(clampRightCol(Math.min(right - dx, right + slack)))
  }, [])

  useEffect(() => {
    if (!cascadeFlash) return
    const id = window.setTimeout(() => setCascadeFlash(null), 1200)
    return () => clearTimeout(id)
  }, [cascadeFlash])

  useEffect(() => {
    void sessionHub.refreshFromServer()
    const id = window.setInterval(() => void sessionHub.refreshFromServer(), 2000)
    loggerRef.current.log('session_bind', {
      seed: seedRef.current,
      subjectId: loggerRef.current.meta.subjectId,
    })
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
    sessionHub.bindMeta({
      experiment: 'tetris',
      subjectId,
      game: 'tetris',
      seed: seedRef.current,
    })
  }, [subjectId])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    stressRef.current = stress
    signalRef.current.push(stress)
  }, [stress, mode])

  useEffect(() => {
    cfgRef.current = cfg
  }, [cfg])

  useEffect(() => {
    localStorage.setItem(MI_CONTROL_KEY, String(miControlEnabled))
    if (!miControlEnabled) {
      lastMiObservationRef.current = null
      setLastMiAction('—')
    }
  }, [miControlEnabled])

  const enableSmrControl = async (enabled: boolean) => {
    setMiControlEnabled(enabled)
    if (!enabled) {
      setCollabEnabled(false)
      return
    }
    setRlEnabled(false)
    setSmrEnsuring(true)
    setSmrEnsureError('')
    try {
      const status = await modelServiceStatus()
      const force = Boolean(status.running && (!status.owned || status.task !== 'smr_control'))
      await ensureModelService({ backend: 'reve', task: 'smr_control', force })
      modelRuntimeHub.setEnabled(true)
      modelRuntimeHub.connect()
    } catch (error) {
      setSmrEnsureError(error instanceof Error ? error.message : String(error))
    } finally {
      setSmrEnsuring(false)
    }
  }

  const enableCollab = async (enabled: boolean) => {
    setCollabEnabled(enabled)
    if (!enabled) return
    setRlEnabled(false)
    setFollowEnabled(false)
    teacherRef.current.reset()
    if (!miControlEnabled) await enableSmrControl(true)
  }

  const enableFollow = async (enabled: boolean) => {
    setFollowEnabled(enabled)
    if (!enabled) return
    setRlEnabled(false)
    setCollabEnabled(false)
    teacherRef.current.reset()
    if (!miControlEnabled) await enableSmrControl(true)
  }

  useEffect(() => {
    localStorage.setItem(RL_CONTROL_KEY, String(rlEnabled))
    if (rlEnabled) {
      setMiControlEnabled(false)
      setCollabEnabled(false)
      setFollowEnabled(false)
      teacherRef.current.reset()
    } else if (!collabEnabled && !followEnabled) {
      setLastRlAction('—')
      setRlLatencyMs(null)
    }
  }, [rlEnabled])

  useEffect(() => {
    localStorage.setItem(COLLAB_CONTROL_KEY, String(collabEnabled))
    if (collabEnabled) teacherRef.current.reset()
    else if (!rlEnabled && !followEnabled) {
      setLastRlAction('—')
      setRlLatencyMs(null)
    }
  }, [collabEnabled])

  useEffect(() => {
    localStorage.setItem(FOLLOW_CONTROL_KEY, String(followEnabled))
    followHumanCountRef.current = 0
    followPieceKeyRef.current = null
    setFollowHumanCount(0)
    if (followEnabled) teacherRef.current.reset()
    else if (!rlEnabled && !collabEnabled) {
      setLastRlAction('—')
      setRlLatencyMs(null)
    }
  }, [followEnabled])

  useEffect(() => {
    localStorage.setItem(FOLLOW_MOVES_KEY, String(followMoves))
    followHumanCountRef.current = 0
    followPieceKeyRef.current = null
    setFollowHumanCount(0)
  }, [followMoves])

  useEffect(() => {
    localStorage.setItem(FOLLOW_STEPS_KEY, String(followSteps))
  }, [followSteps])

  useEffect(() => {
    controlRef.current = followEnabled
      ? 'follow'
      : collabEnabled
        ? 'collab'
        : rlEnabled
          ? 'teacher'
          : miControlEnabled
            ? 'mi'
            : 'human'
  }, [rlEnabled, collabEnabled, followEnabled, miControlEnabled])

  useEffect(() => {
    return () => {
      if (rlAutoRestartRef.current) window.clearTimeout(rlAutoRestartRef.current)
    }
  }, [])

  const applyResult = useCallback((next: GameState, events: GameEvent[]) => {
    stateRef.current = next
    setState(next)
    for (const ev of events) {
      loggerRef.current.log(ev.type, ev as unknown as Record<string, unknown>)
      if (ev.type === 'lock' && ev.linesCleared > 0) {
        setCascadeFlash(
          ev.chains > 1
            ? `连锁 ×${ev.chains}（共消除 ${ev.linesCleared} 行）`
            : `消除 ${ev.linesCleared} 行`,
        )
      } else if (ev.type === 'clear_anim') {
        setCascadeFlash(
          ev.chainIndex > 1
            ? `连锁 ×${ev.chainIndex} · 消除 ${ev.linesCleared} 行`
            : `消除 ${ev.linesCleared} 行`,
        )
      }
    }
  }, [])

  const runFollowBurst = useCallback((afterMove: GameState) => {
    if (!afterMove.piece || afterMove.gameOver || afterMove.paused || afterMove.anim) return
    const t0 = performance.now()
    const burst = applyTeacherFollow(afterMove, followStepsRef.current, rngRef.current)
    const latencyMs = performance.now() - t0
    setRlLatencyMs(latencyMs)
    setLastRlAction(
      burst.actions.length > 0 ? burst.actions.map(describeRlAction).join(' → ') : '跟手 · 无后续',
    )
    applyResult(burst.state, burst.events)
    followPieceKeyRef.current = followPieceKey(burst.state)
    loggerRef.current.log('action', {
      source: 'follow',
      action: burst.actions.join(',') || 'noop',
      steps: burst.actions.length,
      human_moves: followMovesRef.current,
      budget: followStepsRef.current,
      latency_ms: latencyMs,
    })
  }, [applyResult])

  const noteHumanFollowSlide = useCallback((afterMove: GameState) => {
    const turn = noteFollowHumanMove({
      pieceKey: followPieceKey(afterMove),
      prevPieceKey: followPieceKeyRef.current,
      humanCount: followHumanCountRef.current,
      humanMoves: followMovesRef.current,
    })
    followPieceKeyRef.current = turn.pieceKey
    followHumanCountRef.current = turn.humanCount
    setFollowHumanCount(turn.humanCount)
    if (turn.teacherNow) runFollowBurst(afterMove)
    else {
      setLastRlAction(`跟手 · 人 ${turn.humanCount}/${followMovesRef.current}`)
    }
  }, [runFollowBurst])

  useEffect(() => {
    if (!miControlEnabled || rlEnabled) return
    const prediction = modelRuntime.latestPrediction
    if (!prediction || prediction.observation_id === lastMiObservationRef.current) return

    const predicted = miControlActionForPrediction(prediction)
    const action = collabEnabled ? executeMiInCollab(predicted) : predicted
    const filterNote =
      collabEnabled && predicted && predicted !== action ? ' · 协作忽略旋转' : ''
    setLastMiAction(
      `${describeMiControlAction(predicted)}${filterNote} · ${prediction.class_name} ${(prediction.confidence * 100).toFixed(0)}%`,
    )
    lastMiObservationRef.current = prediction.observation_id

    loggerRef.current.log('action', {
      source: isSmrControlPrediction(prediction)
        ? followEnabled
          ? 'follow'
          : collabEnabled
            ? 'collab'
            : 'smr'
        : 'mi',
      action: action === 'rotate' ? 'rotateCW' : (action ?? 'unknown'),
      intended: predicted === 'rotate' ? 'rotateCW' : (predicted ?? 'unknown'),
      class_name: prediction.class_name,
      observation_id: prediction.observation_id,
      confidence: prediction.confidence,
    })

    if (!action || action === 'none') return

    const s = stateRef.current
    if (s.gameOver || s.paused || s.anim) return

    const beforeX = s.piece?.x
    const result = applyMiControlAction(s, action, rngRef.current)
    if (!result) return
    applyResult(result.state, result.events)
    if (
      followEnabled &&
      (action === 'left' || action === 'right') &&
      result.state.piece &&
      result.state.piece.x !== beforeX
    ) {
      noteHumanFollowSlide(result.state)
    }
  }, [miControlEnabled, rlEnabled, collabEnabled, followEnabled, modelRuntime.latestPrediction, applyResult, noteHumanFollowSlide])

  const runRlDecision = useCallback(() => {
    if ((!rlEnabled && !collabEnabled) || rlBusyRef.current) return
    const s = stateRef.current
    if (s.gameOver || s.paused || s.anim) return

    rlBusyRef.current = true
    try {
      const t0 = performance.now()
      const decision = collabEnabled
        ? collabTeacherDecision(s, { gravity: gravityRef.current.smoothed })
        : null
      const intended = decision ? decision.action : teacherRef.current.act(s)
      const action = intended
      const latencyMs = performance.now() - t0
      setRlLatencyMs(latencyMs)
      setLastRlAction(
        decision ? describeCollabDecision(decision, describeRlAction) : describeRlAction(action),
      )

      const latest = stateRef.current
      if (latest.gameOver || latest.paused || latest.anim) return

      const stepped = collabEnabled
        ? applyRlAction(latest, action, rngRef.current)
        : rlStep(latest, action, rngRef.current, {
            cellsPerSec: gravityRef.current.smoothed,
            instantAnim: false,
          })
      applyResult(stepped.state, stepped.events)
      loggerRef.current.log('action', {
        source: collabEnabled ? 'collab' : 'teacher',
        action,
        target_rot: decision?.targetRot ?? null,
        expected: decision?.expected ?? null,
        lock_now: decision?.lockNow ?? null,
        reachable: decision?.reachable ?? null,
        latency_ms: latencyMs,
      })
    } finally {
      rlBusyRef.current = false
    }
  }, [applyResult, rlEnabled, collabEnabled])

  // Smooth game loop — update every frame
  useEffect(() => {
    let raf = 0
    const loop = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts
      const dt = Math.min(50, ts - lastTsRef.current)
      lastTsRef.current = ts
      const dtSec = dt / 1000

      const gState = updateGravity(stressRef.current, cfgRef.current, gravityRef.current, dtSec)
      gravityRef.current = gState
      setGravityDisplay(gState.smoothed)

      traceAccRef.current += dt
      if (traceAccRef.current >= 100) {
        traceAccRef.current = 0
        const elapsed = (performance.now() - t0Ref.current) / 1000
        setTrace((prev) => {
          const next = [
            ...prev,
            {
              t: Math.round(elapsed * 10) / 10,
              stress: stressRef.current,
              gravity: Math.round(gState.smoothed * 100) / 100,
            },
          ]
          return next.length > 300 ? next.slice(-300) : next
        })
        loggerRef.current.logContext(
          tetrisContextSnapshot({
            state: stateRef.current,
            gravity: gState.smoothed,
            gravityMode: cfgRef.current.mode,
            stress: stressRef.current,
            softDrop: softDropHeldRef.current,
            control: controlRef.current,
          }),
        )
      }

      const s = stateRef.current
      const teacherDrive = rlEnabled || collabEnabled
      if (!s.gameOver && !s.paused) {
        if (s.anim) {
          const result = advanceBoardAnim(s, rngRef.current, dt)
          applyResult(result.state, result.events)
        } else if (s.piece && !rlEnabled) {
          if (followEnabled && collides(s.board, s.piece, 0, 1)) {
            const result = holdOrLock(s, rngRef.current, dt, FOLLOW_LOCK_DELAY_MS)
            applyResult(result.state, result.events)
          } else {
            const speed = softDropHeldRef.current
              ? Math.max(gState.smoothed, 22)
              : gState.smoothed
            const result = softDropHeldRef.current
              ? softDropBurst(s, rngRef.current, dtSec, speed)
              : advanceFall(s, rngRef.current, dtSec, speed, false)
            applyResult(result.state, result.events)
          }
        }
      }

      if (teacherDrive) {
        rlDecisionAccRef.current += dt
        if (rlDecisionAccRef.current >= RL_DECISION_INTERVAL_MS) {
          rlDecisionAccRef.current = 0
          runRlDecision()
        }
        const after = stateRef.current
        if (rlEnabled && after.gameOver && !rlAutoRestartRef.current) {
          rlAutoRestartRef.current = window.setTimeout(() => {
            rlAutoRestartRef.current = null
            restart()
          }, 1200)
        }
      }

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [applyResult, rlEnabled, collabEnabled, followEnabled, runRlDecision])

  // Keyboard controls
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' ', 'c', 'C', 'p', 'P', 'r', 'R', 'z', 'Z', 'x', 'X'].includes(
          e.key,
        )
      ) {
        e.preventDefault()
      }
      const s = stateRef.current
      if (e.key === 'p' || e.key === 'P') {
        setState((prev) => {
          const next = { ...prev, paused: !prev.paused }
          stateRef.current = next
          loggerRef.current.log('pause', { paused: next.paused })
          return next
        })
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        restart()
        return
      }
      if (rlEnabled) return
      if (e.key === 'ArrowDown') {
        if (!softDropHeldRef.current) {
          loggerRef.current.log('action', { source: 'keyboard', action: 'softDrop' })
        }
        softDropHeldRef.current = true
        return
      }
      if (s.gameOver || s.paused || s.anim) return
      if (collabEnabled && ['ArrowUp', 'x', 'X', 'z', 'Z'].includes(e.key)) return
      if (followEnabled && e.repeat && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return

      let result
      let action: string | null = null
      if (e.key === 'ArrowLeft') {
        action = 'left'
        result = move(s, -1, rngRef.current)
      } else if (e.key === 'ArrowRight') {
        action = 'right'
        result = move(s, 1, rngRef.current)
      } else if (e.key === 'ArrowUp' || e.key === 'x' || e.key === 'X') {
        action = 'rotateCW'
        result = rotate(s, 1, rngRef.current)
      } else if (e.key === 'z' || e.key === 'Z') {
        action = 'rotateCCW'
        result = rotate(s, -1, rngRef.current)
      } else if (e.key === ' ') {
        action = 'hardDrop'
        result = hardDrop(s, rngRef.current)
      } else return

      loggerRef.current.log('action', { source: 'keyboard', action })
      applyResult(result.state, result.events)
      if (
        followEnabled &&
        (action === 'left' || action === 'right') &&
        result.state.piece &&
        s.piece &&
        result.state.piece.x !== s.piece.x
      ) {
        noteHumanFollowSlide(result.state)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') softDropHeldRef.current = false
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [applyResult, rlEnabled, collabEnabled, followEnabled, noteHumanFollowSlide])

  const restart = () => {
    const nextSeed = (Math.random() * 0xffffffff) >>> 0
    seedRef.current = nextSeed
    rngRef.current = mulberry32(nextSeed)
    const g = createGame(nextSeed)
    stateRef.current = g
    setState(g)
    gravityRef.current = initGravityState(cfgRef.current)
    lastTsRef.current = 0
    t0Ref.current = performance.now()
    softDropHeldRef.current = false
    rlDecisionAccRef.current = 0
    teacherRef.current.reset()
    followHumanCountRef.current = 0
    followPieceKeyRef.current = null
    setFollowHumanCount(0)
    if (rlAutoRestartRef.current) {
      window.clearTimeout(rlAutoRestartRef.current)
      rlAutoRestartRef.current = null
    }
    setTrace([])
    sessionHub.bindMeta({
      experiment: 'tetris',
      subjectId: loggerRef.current.meta.subjectId,
      game: 'tetris',
      seed: nextSeed,
    })
    loggerRef.current.log('restart', { seed: nextSeed })
  }

  const smrPrediction =
    modelRuntime.latestPrediction && isSmrControlPrediction(modelRuntime.latestPrediction)
      ? modelRuntime.latestPrediction
      : null
  const smrHeadWrong =
    miControlEnabled &&
    modelRuntime.status === 'ready' &&
    Boolean(modelRuntime.serviceHello) &&
    !smrPrediction &&
    modelRuntime.serviceHello?.task !== 'smr_control'

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-1 text-2xl font-semibold">实验二 · 压力自适应俄罗斯方块</h1>
          <p className="muted m-0 mt-1 text-sm">
            ←→ 移动 · ↑/X 顺时针 · Z 逆时针 · ↓ 软降 · 空格硬降 · P 暂停 · R 重开
            {miControlEnabled && !collabEnabled ? ' · SMR：左手← 右手→ 双手↻ 休息静止' : ''}
            {collabEnabled ? ' · 协作：脑控←→ · I 无井不竖' : ''}
            {followEnabled ? ` · 跟手：人 ${followMoves} 左右 / 教师 ${followSteps} 左右 · 旋转不计` : ''}
            {rlEnabled ? ' · 启发式教师代打中' : ''}
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
          experiment="tetris"
          getSeed={() => seedRef.current}
          recordControl
        />
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-stretch xl:gap-2">
        <div className="relative w-fit self-center xl:shrink-0 xl:self-start">
          <Board state={state} cell={boardCell} onCellChange={setBoardCell} />
          {cascadeFlash && (
            <div className="pointer-events-none absolute inset-x-0 top-6 text-center">
              <span className="inline-block rounded-full border border-[#f5a52466] bg-[#1a1520ee] px-3 py-1 text-sm font-semibold text-[#f5a524] shadow-lg">
                {cascadeFlash}
              </span>
            </div>
          )}
        </div>

        <ColumnResizer
          label="棋盘宽度"
          className="hidden xl:flex"
          onDragStart={beginColumnDrag}
          onDrag={dragBoardColumn}
          onReset={() => setBoardCell(BOARD_DEFAULT_CELL)}
        />

        <div ref={midColRef} className="min-w-0 flex-1 space-y-4">
          <Panel title="状态">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="分数" value={state.score} />
              <Stat label="消行" value={state.lines} />
              <Stat label="等级" value={state.level} />
              <Stat label="重力" value={`${gravityDisplay.toFixed(2)} 格/秒`} />
            </div>
            <div className="mt-4 flex items-center gap-4">
              <div>
                <div className="muted mb-1 text-xs">下一块</div>
                <NextPreview type={state.next} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setState((s) => {
                      const next = { ...s, paused: !s.paused }
                      stateRef.current = next
                      loggerRef.current.log('pause', { paused: next.paused })
                      return next
                    })
                  }
                >
                  {state.paused ? '继续' : '暂停'}
                </button>
                <button type="button" className="btn btn-primary" onClick={restart}>
                  重开
                </button>
              </div>
            </div>
          </Panel>

          <Panel title="压力 ↔ 下落速度">
            <p className="muted mb-3 text-sm">
              方块按亚格子连续平滑下落。默认：压力越大，下落越快。
            </p>
            <div className="mb-3 flex gap-2">
              {(['challenge', 'regulate'] as GravityMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn ${cfg.mode === m ? 'btn-primary' : ''}`}
                  onClick={() => setCfg((c) => ({ ...c, mode: m }))}
                >
                  {m === 'challenge' ? '挑战（压↑速↑）' : '调节模式 (PI)'}
                </button>
              ))}
            </div>
            {cfg.mode === 'regulate' ? (
              <div className="space-y-3">
                <Slider
                  label="目标压力"
                  value={cfg.setpoint}
                  min={10}
                  max={90}
                  step={1}
                  onChange={(v) => setCfg((c) => ({ ...c, setpoint: v }))}
                />
                <Slider
                  label="Kp"
                  value={cfg.kp}
                  min={0.005}
                  max={0.15}
                  step={0.005}
                  format={(v) => v.toFixed(3)}
                  onChange={(v) => setCfg((c) => ({ ...c, kp: v }))}
                />
                <Slider
                  label="Ki"
                  value={cfg.ki}
                  min={0}
                  max={0.03}
                  step={0.001}
                  format={(v) => v.toFixed(3)}
                  onChange={(v) => setCfg((c) => ({ ...c, ki: v }))}
                />
              </div>
            ) : (
              <p className="muted text-sm">线性偏加速曲线：低压可玩，高压明显加快。</p>
            )}
            <div className="mt-3 space-y-3">
              <Slider
                label="最小重力"
                value={cfg.minGravity}
                min={0.2}
                max={4}
                step={0.1}
                format={(v) => `${v.toFixed(1)} 格/秒`}
                onChange={(v) => setCfg((c) => ({ ...c, minGravity: v }))}
              />
              <Slider
                label="最大重力"
                value={cfg.maxGravity}
                min={2}
                max={20}
                step={0.5}
                format={(v) => `${v.toFixed(1)} 格/秒`}
                onChange={(v) => setCfg((c) => ({ ...c, maxGravity: v }))}
              />
              <Slider
                label="速度平滑"
                value={cfg.smooth}
                min={0.02}
                max={0.5}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => setCfg((c) => ({ ...c, smooth: v }))}
              />
            </div>
          </Panel>

          <RlAgentPanel
            enabled={rlEnabled}
            onEnabledChange={setRlEnabled}
            collabEnabled={collabEnabled}
            onCollabChange={(value) => void enableCollab(value)}
            followEnabled={followEnabled}
            onFollowChange={(value) => void enableFollow(value)}
            followMoves={followMoves}
            onFollowMovesChange={(value) => setFollowMoves(clampFollowMoves(value))}
            followSteps={followSteps}
            onFollowStepsChange={(value) => setFollowSteps(clampFollowSteps(value))}
            followHumanCount={followHumanCount}
            lastAction={lastRlAction}
            latencyMs={rlLatencyMs}
          />

          <Panel title="SMR 控制">
            <label className="acq-check mb-3 flex items-center gap-2">
              <input
                type="checkbox"
                checked={miControlEnabled}
                disabled={rlEnabled || smrEnsuring}
                onChange={(event) => void enableSmrControl(event.target.checked)}
              />
              用 SMR 头操控方块（与键盘并行{collabEnabled ? '；协作时只左右' : followEnabled ? '；跟手旋转不占次数' : ''}）
            </label>
            <p className="muted m-0 mb-3 text-sm">
              左手 → 左移 · 右手 → 右移 · 双手 → 顺时针旋转 · 休息 → 静止。勾选后拉起已拟合、冻结的
              smr_control，每 0.5 秒按当前预测动一次，不在线微调
              {collabEnabled
                ? '。协作模式下手脑旋转会被忽略；I 只在已有深井时才竖放，空盘保持横放。'
                : followEnabled
                  ? '。跟手：人左右 m 次后教师走 n 步；旋转不占次数。'
                  : '。'}
            </p>
            {smrEnsureError ? (
              <p className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
                {smrEnsureError}
              </p>
            ) : null}
            {smrHeadWrong ? (
              <p className="mb-3 text-sm" style={{ color: 'var(--warn)' }}>
                当前不是 SMR 头（{modelRuntime.serviceHello?.task ?? modelRuntime.latestPrediction?.task ?? '未知'}）。
                <button
                  type="button"
                  className="btn ml-2"
                  disabled={smrEnsuring}
                  onClick={() => void enableSmrControl(true)}
                >
                  切换到 smr_control
                </button>
              </p>
            ) : null}
            <div className="rounded-xl border border-[var(--border)] bg-[#0f1526] px-3 py-2 text-sm">
              <div className="muted text-xs">最近 SMR 动作</div>
              <div className="font-mono text-xs">{lastMiAction}</div>
              {smrPrediction ? (
                <div className="mt-2 space-y-1">
                  {smrPrediction.class_names.map((name, index) => {
                    const value = smrPrediction.probabilities[index] ?? 0
                    return (
                      <div key={`${name}-${index}`}>
                        <div className="mb-0.5 flex justify-between text-xs">
                          <span>{describeMiControlAction(miControlActionForClassName(name))}</span>
                          <span className="muted">{(value * 100).toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--panel-2)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(0, Math.min(100, value * 100))}%`,
                              background: 'var(--accent)',
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
            <div className="mt-4">
              <ModelServicePanel embedded reveTask="smr_control" />
            </div>
          </Panel>

          <Panel title="实时曲线">
            <LineChart
              data={trace}
              xKey="t"
              dualAxis
              series={[
                { key: 'stress', name: '压力', color: '#f5a524', yAxisId: 'left' },
                { key: 'gravity', name: '重力', color: '#5b8cff', yAxisId: 'right' },
              ]}
            />
          </Panel>
        </div>

        <ColumnResizer
          label="侧栏宽度"
          className="hidden xl:flex"
          onDragStart={beginColumnDrag}
          onDrag={dragRightColumn}
          onReset={() => setRightCol(RIGHT_COL_DEFAULT)}
        />

        <div
          className="min-w-0 space-y-4 xl:w-[var(--right-col)] xl:shrink-0"
          style={{ '--right-col': `${rightCol}px` } as React.CSSProperties}
        >
          <StressPanel
            stress={stress}
            onChange={setStress}
            mode={mode}
            modeControls={
              <SignalModeControls
                mode={mode}
                onModeChange={setMode}
                driverFeature={driverFeature}
                onDriverChange={setDriverFeature}
                rangeMap={rangeMap}
                onRangeMapChange={setRangeMap}
                onRangeReset={resetRangeMap}
                onRangeCapture={captureRangeFromWindow}
                rangePreview={rangePreview}
              />
            }
          />
          <FeatureMonitorPanel
            compact
            latest={features.latest}
            history={features.history}
            analyzing={features.analyzing}
            enabledIds={features.enabledIds}
            onEnabledChange={features.onEnabledChange}
            note={
              mode === 'live'
                ? features.origin === 'live'
                  ? `实时 EEG 调控中（${driverFeature}）。点「手动输入」接管。`
                  : '已选实时 EEG，但尚未收到样本。请到采集页连接并开始采集。'
                : mode === 'features'
                  ? `演示数据调控中（${driverFeature}）→ 压力应持续波动。点「手动输入」接管。`
                  : '手动模式：滑块控制难度。有实时流时特征面板显示真实 EEG。'
            }
          />
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[#0f1526] px-3 py-2">
      <div className="muted text-xs">{label}</div>
      <div className="font-mono text-lg">{value}</div>
    </div>
  )
}

export default TetrisExperiment
