import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { mulberry32 } from '../../lib/rng'
import { ManualSignalSource } from '../../lib/signal/manual'
import { easeInOutCubic } from '../../lib/timing'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { FeatureMonitorPanel, useFeatureMonitor } from '../../lib/features'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { LineChart } from '../../lib/ui/LineChart'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import {
  modelRuntimeHub,
  predictionToOrdinalRating,
  useModelRuntime,
  type ModelPrediction,
} from '../../lib/model-runtime'
import {
  bfsDistance,
  countLeaves,
  generateGraph,
  pickRandomStart,
  type Graph,
  type GraphMode,
} from './graph'
import { GraphCanvas } from './GraphCanvas'
import {
  createQTable,
  epsilonGreedy,
  tdUpdate,
  type QParams,
  type QTable,
} from './qlearning'
import { RatingPrompt } from './RatingPrompt'
import { HeadFeaturePicker } from './HeadFeaturePicker'
import { LinearHeadDebug } from './LinearHeadDebug'
import {
  extractLinearFeatures,
  LinearHead,
  LINEAR_HEAD_CLASSES,
  LINEAR_HEAD_MIN_TRAIN,
  ensureIdsForHeadFeatures,
  ratingToClass,
  type LinearHeadPred,
  type LinearHeadStats,
} from './linearHead'
import {
  algoLabel,
  defaultTamerParams,
  tamerUpdate,
  type LearnAlgo,
  type TamerParams,
  type TamerTraceStep,
} from './tamer'
import { corruptRating, maybeFlipRating, randomRating } from './ratingNoise'
import {
  applyAiQUpdates,
  buildQCandidates,
  loadLlmConfig,
  normalizeApiKey,
  normalizeLlmEndpoint,
  requestAiQAssignment,
  saveLlmConfig,
  type LlmApiConfig,
} from './aiCredit'

const ANIM_MS = 400
const W = 720
const H = 480
/** Auto human-rating when the agent steps onto the goal. */
const AUTO_GOAL_RATING = 1

type Phase = 'idle' | 'moving' | 'rating' | 'ai_updating' | 'converged'
type RewardMode = 'human' | 'eeg' | 'foundation' | 'random' | 'randomKeepGoal'

export function RlGraphExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const linearHeadRef = useRef<LinearHead | null>(null)
  if (!linearHeadRef.current) linearHeadRef.current = LinearHead.load()
  const [headKeys, setHeadKeys] = useState(() => linearHeadRef.current!.keys)
  const headKeysRef = useRef(headKeys)
  headKeysRef.current = headKeys
  const headEnsure = useMemo(() => ensureIdsForHeadFeatures(headKeys), [headKeys])
  const features = useFeatureMonitor({
    active: true,
    ensureFeatures: headEnsure,
  })
  const modelRuntime = useModelRuntime()
  const latestValuesRef = useRef(features.latest?.values)
  latestValuesRef.current = features.latest?.values
  const pendingFeatRef = useRef<number[] | null>(null)
  const [headStats, setHeadStats] = useState<LinearHeadStats>(() => linearHeadRef.current!.stats())
  const [stepHeadPred, setStepHeadPred] = useState<LinearHeadPred | null>(null)
  const liveHeadX = useMemo(
    () => extractLinearFeatures(features.latest?.values, headKeys),
    [features.latest, headKeys],
  )
  const liveHeadPred = useMemo(
    () => (liveHeadX ? linearHeadRef.current!.predict(liveHeadX) : null),
    [liveHeadX, headStats, headKeys],
  )
  const foundationRating = modelRuntime.latestPrediction
    ? predictionToOrdinalRating(modelRuntime.latestPrediction)
    : null
  const foundationHeadPred: LinearHeadPred | null =
    modelRuntime.latestPrediction && foundationRating !== null
      ? {
          classIndex: modelRuntime.latestPrediction.class_id,
          label: LINEAR_HEAD_CLASSES[modelRuntime.latestPrediction.class_id]!,
          rating: foundationRating,
          probs: modelRuntime.latestPrediction.probabilities,
        }
      : null
  const [mode, setMode] = useState<GraphMode>('graph')
  const [nodeCount, setNodeCount] = useState(24)
  const [gridCols, setGridCols] = useState(6)
  const [gridRows, setGridRows] = useState(5)
  const [density, setDensity] = useState(1.8)
  const [leafStartOnly, setLeafStartOnly] = useState(false)
  const [algo, setAlgo] = useState<LearnAlgo>('tamer')
  const [tamerParams, setTamerParams] = useState<TamerParams>(() => defaultTamerParams())
  const [seed, setSeed] = useState(() => (Math.random() * 0xffffffff) >>> 0)

  const [graph, setGraph] = useState<Graph>(() =>
    generateGraph({
      mode: 'graph',
      nodeCount: 24,
      density: 1.8,
      seed,
      width: W,
      height: H,
    }),
  )

  const [qTable, setQTable] = useState<QTable>(() => createQTable())
  const [episodeStart, setEpisodeStart] = useState(() =>
    pickRandomStart(graph, mulberry32(seed ^ 0x9e3779b9), { leafOnly: false }),
  )
  const [agentPos, setAgentPos] = useState(episodeStart)
  const [phase, setPhase] = useState<Phase>('idle')
  const [animFrom, setAnimFrom] = useState<number | null>(null)
  const [animTo, setAnimTo] = useState<number | null>(null)
  const [animT, setAnimT] = useState(0)
  const [episode, setEpisode] = useState(1)
  const [steps, setSteps] = useState(0)
  const [episodeSteps, setEpisodeSteps] = useState<
    { episode: number; steps: number; shortest: number }[]
  >([])
  const [shortestStreak, setShortestStreak] = useState(0)
  const [running, setRunning] = useState(false)
  const [infiniteWait, setInfiniteWait] = useState(false)
  const [skipWaitAfterRate, setSkipWaitAfterRate] = useState(true)
  const [ratingTimeout, setRatingTimeout] = useState(1500)
  const [noiseEnabled, setNoiseEnabled] = useState(false)
  const [noiseSigma, setNoiseSigma] = useState(0.25)
  const [noiseFlipProb, setNoiseFlipProb] = useState(0.05)
  /**
   * Reward source for auto-run baselines:
   * - human: wait for key/click ratings
   * - eeg: linear 3-class head; keys train, timeout predicts
   * - random: uniform {-1..1} every step (incl. goal)
   * - randomKeepGoal: random on non-goal steps; goal still gets +AUTO_GOAL_RATING
   */
  const [rewardMode, setRewardMode] = useState<RewardMode>('human')
  const [maxSteps, setMaxSteps] = useState(60)
  const [convergeN, setConvergeN] = useState(3)
  const [params, setParams] = useState<QParams>({
    alpha: 0.4,
    gamma: 0.9,
    epsilon: 0.2,
    stepPenalty: -0.05,
    goalReward: 1,
  })
  const [llmConfig, setLlmConfig] = useState<LlmApiConfig>(() => loadLlmConfig())
  const [showApi, setShowApi] = useState(false)
  const [aiNotice, setAiNotice] = useState('')
  const [lastAiSummary, setLastAiSummary] = useState('')

  const pendingRef = useRef<{ from: number; to: number } | null>(null)
  const loggerRef = useRef(new SessionLogger('rl-graph', subjectId))
  const signalRef = useRef(new ManualSignalSource({ kind: 'rating', initial: 0 }))
  const rngRef = useRef(mulberry32(seed ^ 0x9e3779b9))
  const runningRef = useRef(false)
  const phaseRef = useRef<Phase>('idle')
  const autoAdvanceRef = useRef(false)
  const agentPosRef = useRef(agentPos)
  const stepsRef = useRef(steps)
  const qTableRef = useRef(qTable)
  const episodeRef = useRef(episode)
  const shortestStreakRef = useRef(shortestStreak)
  const episodeStartRef = useRef(episodeStart)
  const leafOnlyRef = useRef(leafStartOnly)
  const graphRef = useRef(graph)
  const algoRef = useRef(algo)
  const tamerParamsRef = useRef(tamerParams)
  const paramsRef = useRef(params)
  const noiseRef = useRef({ enabled: false, sigma: 0.25, flipProb: 0.05 })
  const rewardModeRef = useRef<RewardMode>('human')
  const pendingModelObservationRef = useRef<ModelPrediction | null>(null)
  const loggedModelObservationRef = useRef('')
  const loggedFeedbackAckRef = useRef('')
  const traceRef = useRef<TamerTraceStep[]>([])
  const llmConfigRef = useRef(llmConfig)
  const applyLockRef = useRef(false)

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    llmConfigRef.current = llmConfig
  }, [llmConfig])

  useEffect(() => {
    runningRef.current = running
  }, [running])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    agentPosRef.current = agentPos
  }, [agentPos])

  useEffect(() => {
    stepsRef.current = steps
  }, [steps])

  useEffect(() => {
    qTableRef.current = qTable
  }, [qTable])

  useEffect(() => {
    episodeRef.current = episode
  }, [episode])

  useEffect(() => {
    shortestStreakRef.current = shortestStreak
  }, [shortestStreak])

  useEffect(() => {
    episodeStartRef.current = episodeStart
  }, [episodeStart])

  useEffect(() => {
    leafOnlyRef.current = leafStartOnly
  }, [leafStartOnly])

  useEffect(() => {
    graphRef.current = graph
  }, [graph])

  useEffect(() => {
    algoRef.current = algo
  }, [algo])

  useEffect(() => {
    tamerParamsRef.current = tamerParams
  }, [tamerParams])

  useEffect(() => {
    paramsRef.current = params
  }, [params])

  useEffect(() => {
    noiseRef.current = {
      enabled: noiseEnabled,
      sigma: noiseSigma,
      flipProb: noiseFlipProb,
    }
  }, [noiseEnabled, noiseSigma, noiseFlipProb])

  useEffect(() => {
    rewardModeRef.current = rewardMode
  }, [rewardMode])

  useEffect(() => {
    const prediction = modelRuntime.latestPrediction
    if (!prediction || loggedModelObservationRef.current === prediction.observation_id) return
    loggedModelObservationRef.current = prediction.observation_id
    loggerRef.current.log('foundation_prediction', {
      observationId: prediction.observation_id,
      windowId: prediction.window_id,
      segmentId: prediction.segment_id,
      classId: prediction.class_id,
      className: prediction.class_name,
      confidence: prediction.confidence,
      probabilities: prediction.probabilities,
      modelRevision: prediction.model_revision,
      onlineUpdateStep: prediction.online_update_step,
      onlineUpdateApplied: prediction.online_update_applied,
      outputSemantics: prediction.output_semantics,
      task: prediction.task,
    })
  }, [modelRuntime.latestPrediction])

  useEffect(() => {
    const ack = modelRuntime.lastFeedbackAck
    if (!ack || loggedFeedbackAckRef.current === ack.feedback_id) return
    loggedFeedbackAckRef.current = ack.feedback_id
    loggerRef.current.log('foundation_feedback_ack', {
      feedbackId: ack.feedback_id,
      observationId: ack.observation_id,
      accepted: ack.accepted,
      duplicate: ack.duplicate,
      reason: ack.reason,
      modelRevision: ack.model_revision,
      onlineUpdateStep: ack.online_update_step,
      onlineUpdateApplied: ack.online_update_applied,
    })
  }, [modelRuntime.lastFeedbackAck])

  const shortest = useMemo(
    () => bfsDistance(graph, episodeStart, graph.goal),
    [graph, episodeStart],
  )

  const leafCount = useMemo(() => countLeaves(graph), [graph])

  const spawnEpisode = useCallback(
    (g: Graph, ep: number) => {
      const start = pickRandomStart(g, rngRef.current, {
        leafOnly: leafOnlyRef.current,
        excludeGoal: true,
      })
      episodeStartRef.current = start
      setEpisodeStart(start)
      agentPosRef.current = start
      setAgentPos(start)
      stepsRef.current = 0
      setSteps(0)
      setPhase('idle')
      pendingRef.current = null
      pendingModelObservationRef.current = null
      setAnimFrom(null)
      setAnimTo(null)
      traceRef.current = []
      loggerRef.current.log('episode_start', {
        episode: ep,
        start,
        goal: g.goal,
        shortest: bfsDistance(g, start, g.goal),
        leafOnly: leafOnlyRef.current,
      })
      return start
    },
    [],
  )

  const regenerate = useCallback(
    (nextSeed?: number, nextMode?: GraphMode) => {
      const s = nextSeed ?? ((Math.random() * 0xffffffff) >>> 0)
      const m = nextMode ?? mode
      const g = generateGraph({
        mode: m,
        nodeCount,
        cols: gridCols,
        rows: gridRows,
        density,
        seed: s,
        width: W,
        height: H,
      })
      setSeed(s)
      setMode(m)
      setGraph(g)
      graphRef.current = g
      setQTable(createQTable())
      qTableRef.current = createQTable()
      setEpisode(1)
      episodeRef.current = 1
      setEpisodeSteps([])
      setShortestStreak(0)
      shortestStreakRef.current = 0
      setRunning(false)
      rngRef.current = mulberry32(s ^ 0x9e3779b9)
      spawnEpisode(g, 1)
      loggerRef.current.log('regenerate', {
        seed: s,
        mode: m,
        nodeCount: g.nodes.length,
        density,
        cols: gridCols,
        rows: gridRows,
        algo: algoRef.current,
      })
    },
    [mode, nodeCount, gridCols, gridRows, density, spawnEpisode],
  )

  const resetValueTable = () => {
    const fresh = createQTable()
    setQTable(fresh)
    qTableRef.current = fresh
    setEpisode(1)
    episodeRef.current = 1
    setEpisodeSteps([])
    setShortestStreak(0)
    shortestStreakRef.current = 0
    setRunning(false)
    traceRef.current = []
    spawnEpisode(graphRef.current, 1)
    loggerRef.current.log('reset_table', { algo: algoRef.current })
  }

  const switchAlgo = (next: LearnAlgo) => {
    if (next === algo) return
    setAlgo(next)
    algoRef.current = next
    setRunning(false)
    const fresh = createQTable()
    setQTable(fresh)
    qTableRef.current = fresh
    setEpisode(1)
    episodeRef.current = 1
    setEpisodeSteps([])
    setShortestStreak(0)
    shortestStreakRef.current = 0
    traceRef.current = []
    spawnEpisode(graphRef.current, 1)
    loggerRef.current.log('switch_algo', { algo: next })
  }

  const animateMove = useCallback((from: number, to: number): Promise<void> => {
    return new Promise((resolve) => {
      setPhase('moving')
      setAnimFrom(from)
      setAnimTo(to)
      setAnimT(0)
      const t0 = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / ANIM_MS)
        setAnimT(easeInOutCubic(t))
        if (t < 1) {
          requestAnimationFrame(tick)
        } else {
          agentPosRef.current = to
          setAgentPos(to)
          setAnimFrom(null)
          setAnimTo(null)
          setAnimT(0)
          resolve()
        }
      }
      requestAnimationFrame(tick)
    })
  }, [])

  const finishAfterReward = useCallback(
    (done: boolean, nextSteps: number, ep: number, epShortest: number, g: Graph) => {
      if (done || nextSteps >= maxSteps) {
        const used = nextSteps
        const isShort = done && used <= epShortest
        setEpisodeSteps((arr) => [
          ...arr,
          { episode: ep, steps: used, shortest: epShortest },
        ])
        const streak = isShort ? shortestStreakRef.current + 1 : 0
        shortestStreakRef.current = streak
        setShortestStreak(streak)
        loggerRef.current.log('episode_end', {
          episode: ep,
          steps: used,
          reached: done,
          shortest: epShortest,
          isShort,
          start: episodeStartRef.current,
          algo: algoRef.current,
        })

        if (streak >= convergeN) {
          setPhase('converged')
          setRunning(false)
          loggerRef.current.log('converged', { episode: ep, streak })
          return
        }

        const nextEp = ep + 1
        episodeRef.current = nextEp
        setEpisode(nextEp)
        spawnEpisode(g, nextEp)
        autoAdvanceRef.current = runningRef.current
      } else {
        setPhase('idle')
        autoAdvanceRef.current = runningRef.current
      }
    },
    [maxSteps, convergeN, spawnEpisode],
  )

  const applyReward = useCallback(
    async (humanReward: number | null, auto = false, feedbackText = '') => {
      const pending = pendingRef.current
      if (!pending || (phaseRef.current !== 'rating' && phaseRef.current !== 'ai_updating')) return
      if (applyLockRef.current) return
      applyLockRef.current = true

      const g = graphRef.current
      const done = pending.to === g.goal
      const nextSteps = stepsRef.current
      const ep = episodeRef.current
      const epShortest = bfsDistance(g, episodeStartRef.current, g.goal)
      const timedOut = humanReward === null

      if (!auto && humanReward !== null && rewardModeRef.current === 'eeg') {
        const x = pendingFeatRef.current
        const head = linearHeadRef.current!
        if (x && x.length === head.nFeat) {
          head.train(x, ratingToClass(humanReward))
          head.save()
          setHeadStats(head.stats())
        }
      }

      let observed: number | null = timedOut ? null : humanReward
      let clean: number | null = observed
      if (observed !== null && noiseRef.current.enabled) {
        const flipped = maybeFlipRating(observed, noiseRef.current.flipProb, rngRef.current)
        observed = corruptRating(flipped, noiseRef.current.sigma, rngRef.current)
      }

      const modelObservation = pendingModelObservationRef.current
      let modelFeedbackId: string | null = null
      if (!auto && humanReward !== null && modelObservation) {
        const ordinal = predictionToOrdinalRating(modelObservation)
        modelFeedbackId = modelRuntimeHub.submitFeedback({
          observationId: modelObservation.observation_id,
          reward: humanReward,
          ...(ordinal === null ? {} : { label: ratingToClass(humanReward) }),
          metadata: {
            experiment: 'rl-graph',
            subjectId,
            episode: ep,
            step: nextSteps,
            from: pending.from,
            to: pending.to,
          },
        })
      }

      try {
        if (observed !== null) {
          signalRef.current.push(observed, {
            from: pending.from,
            to: pending.to,
            auto,
            clean,
            noisy: noiseRef.current.enabled,
            feedbackText: feedbackText || undefined,
          })

          if (algoRef.current === 'ai') {
            setPhase('ai_updating')
            phaseRef.current = 'ai_updating'
            setAiNotice('AI 正在根据评分/文字分配局部 Q…')

            const candidates = buildQCandidates(
              qTableRef.current,
              g,
              pending,
              traceRef.current,
              tamerParamsRef.current.creditWindow,
            )
            const result = await requestAiQAssignment({
              config: llmConfigRef.current,
              candidates,
              rating: observed,
              feedbackText,
              reachedGoal: done,
            })

            setQTable((prev) => {
              const copy: QTable = { values: new Map(prev.values) }
              const n = applyAiQUpdates(copy, candidates, result.updates)
              qTableRef.current = copy
              setLastAiSummary(
                `${result.provider} · ${result.latencyMs}ms · 更新 ${n}/${candidates.length} 个候选` +
                  (result.rawText?.startsWith('remote_failed:') ? '（已回退本地）' : ''),
              )
              return copy
            })

            loggerRef.current.log('ai_q_assign', {
              provider: result.provider,
              latencyMs: result.latencyMs,
              updates: result.updates,
              candidates: candidates.map((c) => ({
                id: c.id,
                role: c.role,
                currentQ: c.currentQ,
                justTaken: Boolean(c.justTaken),
              })),
              rating: observed,
              feedbackText,
              done,
              reasoning: result.reasoning?.slice(0, 500),
            })
            setAiNotice('')
          } else {
            setQTable((prev) => {
              const copy: QTable = { values: new Map(prev.values) }
              if (algoRef.current === 'tamer') {
                tamerUpdate(copy, observed, traceRef.current, tamerParamsRef.current)
              } else {
                tdUpdate(
                  copy,
                  g,
                  pending.from,
                  pending.to,
                  pending.to,
                  observed,
                  paramsRef.current,
                  done,
                )
              }
              qTableRef.current = copy
              return copy
            })
          }
        }

        loggerRef.current.log(timedOut ? 'rating_timeout' : 'rating', {
          from: pending.from,
          to: pending.to,
          humanReward: observed,
          clean,
          auto,
          timedOut,
          noise: noiseRef.current.enabled,
          rewardMode: rewardModeRef.current,
          linearHeadN: linearHeadRef.current!.nTrain,
          modelObservationId: modelObservation?.observation_id,
          modelRevision: modelObservation?.model_revision,
          modelFeedbackId: modelFeedbackId ?? undefined,
          done,
          episode: ep,
          steps: nextSteps,
          algo: algoRef.current,
          updated: observed !== null,
          feedbackText: feedbackText || undefined,
        })

        pendingRef.current = null
        pendingFeatRef.current = null
        pendingModelObservationRef.current = null
        finishAfterReward(done, nextSteps, ep, epShortest, g)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setAiNotice(`AI 分配失败：${message}`)
        setPhase('rating')
        phaseRef.current = 'rating'
        loggerRef.current.log('ai_q_error', { message })
      } finally {
        applyLockRef.current = false
      }
    },
    [finishAfterReward, subjectId],
  )

  const takeStep = useCallback(async () => {
    if (phaseRef.current !== 'idle') return

    const g = graphRef.current
    const from = agentPosRef.current
    const eps =
      algoRef.current === 'qlearning' ? paramsRef.current.epsilon : tamerParamsRef.current.epsilon
    const action = epsilonGreedy(qTableRef.current, g, from, eps, rngRef.current)
    if (action === null) return

    pendingRef.current = { from, to: action }
    traceRef.current = [...traceRef.current, { state: from, action }]
    loggerRef.current.log('step_chosen', {
      from,
      to: action,
      episode: episodeRef.current,
      steps: stepsRef.current,
      algo: algoRef.current,
    })
    await animateMove(from, action)
    stepsRef.current += 1
    setSteps(stepsRef.current)
    pendingModelObservationRef.current = modelRuntimeHub.latestObservation()

    // Reaching the goal
    if (action === g.goal) {
      setPhase('rating')
      queueMicrotask(() => {
        phaseRef.current = 'rating'
        const mode = rewardModeRef.current
        if (mode === 'random') {
          void applyReward(randomRating(rngRef.current), true)
        } else {
          // human + randomKeepGoal: keep structured goal reward
          void applyReward(AUTO_GOAL_RATING, true, algoRef.current === 'ai' ? '到达终点' : '')
        }
      })
      return
    }

    // Non-goal: random modes auto-rate; human / eeg wait for prompt
    if (
      rewardModeRef.current !== 'human' &&
      rewardModeRef.current !== 'eeg' &&
      rewardModeRef.current !== 'foundation'
    ) {
      setPhase('rating')
      queueMicrotask(() => {
        phaseRef.current = 'rating'
        void applyReward(randomRating(rngRef.current), true)
      })
      return
    }

    const x = extractLinearFeatures(latestValuesRef.current, headKeysRef.current)
    pendingFeatRef.current = x
    setStepHeadPred(x ? linearHeadRef.current!.predict(x) : null)
    setPhase('rating')
  }, [animateMove, applyReward])

  // Auto-advance after rating when running
  useEffect(() => {
    if (phase !== 'idle' || !running || !autoAdvanceRef.current) return
    autoAdvanceRef.current = false
    const id = window.setTimeout(() => {
      void takeStep()
    }, 200)
    return () => clearTimeout(id)
  }, [phase, running, takeStep, episode, steps])

  // Kick off when user presses Start
  useEffect(() => {
    if (!running) return
    if (phase === 'idle') {
      autoAdvanceRef.current = true
      const id = window.setTimeout(() => {
        void takeStep()
      }, 100)
      return () => clearTimeout(id)
    }
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  const chartData = episodeSteps.map((e) => ({
    episode: e.episode,
    steps: e.steps,
    shortest: e.shortest,
  }))

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-1 text-2xl font-semibold">实验一 · 人脑反馈强化学习</h1>
          <p className="muted m-0 mt-1 text-sm">
            {algoLabel(algo)} · {mode === 'grid' ? '网格' : '图'}模式 · {graph.nodes.length} 节点 ·
            本局最短路 {Number.isFinite(shortest) ? shortest : '—'} 步 · 种子 {seed}
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Panel className="relative min-h-[520px] overflow-hidden p-3">
          <GraphCanvas
            graph={graph}
            qTable={qTable}
            agentPos={agentPos}
            episodeStart={episodeStart}
            animFrom={animFrom}
            animTo={animTo}
            animT={animT}
            width={W}
            height={H}
          />
          <RatingPrompt
            open={
              phase === 'ai_updating' ||
              (phase === 'rating' &&
                agentPos !== graph.goal &&
                (rewardMode === 'human' || rewardMode === 'eeg' || rewardMode === 'foundation'))
            }
            timeoutMs={ratingTimeout}
            infinite={infiniteWait || algo === 'ai'}
            skipWaitAfterRate={skipWaitAfterRate}
            enableText={algo === 'ai'}
            busy={phase === 'ai_updating'}
            busyLabel={aiNotice || 'AI 正在分配 Q…'}
            eegMode={rewardMode === 'eeg' || rewardMode === 'foundation'}
            eegTitle={rewardMode === 'foundation' ? '基座模型任务头' : undefined}
            eegHint={
              rewardMode === 'foundation'
                ? foundationHeadPred
                  ? '倒计时结束使用当前 ordinal_rating_3 输出；按 1–5 会将反馈关联回该 observation。'
                  : '服务尚未返回 ordinal_rating_3；不会把运动想象或未知分类静默当成评分。'
                : undefined
            }
            headReady={
              rewardMode === 'foundation'
                ? foundationHeadPred !== null
                : headStats.nTrain >= LINEAR_HEAD_MIN_TRAIN
            }
            headNTrain={
              rewardMode === 'foundation'
                ? (modelRuntime.latestPrediction?.online_update_step ?? 0)
                : headStats.nTrain
            }
            headMinTrain={rewardMode === 'foundation' ? 0 : LINEAR_HEAD_MIN_TRAIN}
            headPred={
              rewardMode === 'foundation' ? foundationHeadPred : (stepHeadPred ?? liveHeadPred)
            }
            onRate={(v, text) => void applyReward(v, false, text ?? '')}
            onTimeout={() => {
              if (rewardModeRef.current === 'foundation') {
                const prediction =
                  pendingModelObservationRef.current ?? modelRuntimeHub.latestObservation()
                const rating = prediction ? predictionToOrdinalRating(prediction) : null
                if (rating !== null) {
                  void applyReward(rating, true, 'foundation-model')
                  return
                }
                void applyReward(null, false)
                return
              }
              if (rewardModeRef.current === 'eeg') {
                const head = linearHeadRef.current!
                const x =
                  pendingFeatRef.current ??
                  extractLinearFeatures(latestValuesRef.current, headKeysRef.current)
                if (head.nTrain >= LINEAR_HEAD_MIN_TRAIN && x && x.length === head.nFeat) {
                  const pred = head.predict(x)
                  void applyReward(pred.rating, true, 'linear-head')
                  return
                }
              }
              void applyReward(null, false)
            }}
          />
          {phase === 'converged' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="panel mx-auto max-w-sm p-6 text-center">
                <h3 className="m-0 text-xl">已收敛</h3>
                <p className="muted mt-2 text-sm">
                  连续 {convergeN} 局走出该局最短路。
                </p>
                <button type="button" className="btn btn-primary mt-4" onClick={resetValueTable}>
                  重置价值表再来
                </button>
              </div>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="控制">
            <div className="flex flex-wrap gap-2">
              {!running ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    if (phase === 'converged') return
                    setRunning(true)
                    loggerRef.current.log('start')
                  }}
                >
                  开始 / 继续
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setRunning(false)
                    loggerRef.current.log('pause')
                  }}
                >
                  暂停
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={phase !== 'idle' || running}
                onClick={() => void takeStep()}
              >
                单步
              </button>
              <button type="button" className="btn" onClick={resetValueTable}>
                重置表
              </button>
              <button type="button" className="btn" onClick={() => regenerate()}>
                新图
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="chip justify-center">局 {episode}</div>
              <div className="chip justify-center">
                步 {steps}/{maxSteps}
              </div>
              <div className="chip justify-center">
                最短连胜 {shortestStreak}/{convergeN}
              </div>
              <div className="chip justify-center">{algoLabel(algo)}</div>
            </div>
          </Panel>

          <Panel title="学习算法">
            <div className="mb-3 flex flex-wrap gap-2">
              {(['tamer', 'qlearning', 'ai'] as LearnAlgo[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`btn flex-1 min-w-[5.5rem] ${algo === a ? 'btn-primary' : ''}`}
                  onClick={() => switchAlgo(a)}
                  disabled={running || phase === 'moving' || phase === 'rating' || phase === 'ai_updating'}
                >
                  {algoLabel(a)}
                </button>
              ))}
            </div>
            {algo === 'tamer' ? (
              <p className="muted text-xs leading-relaxed">
                TAMER：把评分当作监督目标，直接学 Ĥ(s,a)（预测人会给多少分），不做 TD
                bootstrap。选动作时贪心最大化 Ĥ（加 ε 探索）。边颜色表示学到的人类偏好。
              </p>
            ) : algo === 'ai' ? (
              <p className="muted text-xs leading-relaxed">
                AI 分配 Q：评分 + 可选文字反馈交给模型；模型可见本步局部 Q 候选（刚执行、同状态兄弟、信用窗口内更早步），但看不到完整图/坐标/终点位置。模型直接写出各候选的新 Q。
              </p>
            ) : (
              <p className="muted text-xs leading-relaxed">
                Q-learning：把人工评分并入 reward，用 TD 更新 Q(s,a)←Q+α[r+γ max
                Q(s′,·)−Q]。边颜色表示 Q 值。
              </p>
            )}
            {algo === 'ai' && lastAiSummary && (
              <p className="mt-2 text-xs text-[var(--accent)]">{lastAiSummary}</p>
            )}
          </Panel>

          <Panel title="地图模式">
            <div className="mb-3 flex gap-2">
              {(['graph', 'grid'] as GraphMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn flex-1 ${mode === m ? 'btn-primary' : ''}`}
                  onClick={() => {
                    setMode(m)
                    regenerate(undefined, m)
                  }}
                >
                  {m === 'graph' ? '图模式' : '网格模式'}
                </button>
              ))}
            </div>

            {mode === 'graph' ? (
              <div className="space-y-3">
                <Slider
                  label="节点数"
                  value={nodeCount}
                  min={12}
                  max={48}
                  step={1}
                  onChange={setNodeCount}
                />
                <Slider
                  label="边密度"
                  value={density}
                  min={1.2}
                  max={3}
                  step={0.1}
                  format={(v) => v.toFixed(1)}
                  onChange={setDensity}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <Slider
                  label="列数"
                  value={gridCols}
                  min={4}
                  max={10}
                  step={1}
                  onChange={setGridCols}
                />
                <Slider
                  label="行数"
                  value={gridRows}
                  min={3}
                  max={8}
                  step={1}
                  onChange={setGridRows}
                />
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary mt-3 w-full"
              onClick={() => regenerate()}
            >
              按当前设置生成
            </button>
          </Panel>

          <Panel title="起点采样">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={leafStartOnly}
                onChange={(e) => setLeafStartOnly(e.target.checked)}
              />
              <span>
                仅从叶节点出发（度=1）
                <span className="muted mt-0.5 block text-xs">
                  无向图中类似「入度为 0 的入口」。当前可用叶节点 {leafCount} 个；
                  不足时自动回退到任意非终点。
                </span>
              </span>
            </label>
            <p className="muted mt-2 text-xs">
              每局结束（到达终点或超时）后，光标会在节点上重新随机出生；终点固定。
            </p>
          </Panel>

          <Panel title="学习参数">
            <div className="space-y-3">
              {algo === 'tamer' || algo === 'ai' ? (
                <>
                  {algo === 'tamer' && (
                    <Slider
                      label="α 学习率"
                      value={tamerParams.alpha}
                      min={0.05}
                      max={1}
                      step={0.05}
                      format={(v) => v.toFixed(2)}
                      onChange={(v) => setTamerParams((p) => ({ ...p, alpha: v }))}
                    />
                  )}
                  <Slider
                    label="ε 探索"
                    value={tamerParams.epsilon}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setTamerParams((p) => ({ ...p, epsilon: v }))}
                  />
                  <Slider
                    label="信用窗口（步）"
                    value={tamerParams.creditWindow}
                    min={1}
                    max={8}
                    step={1}
                    onChange={(v) => setTamerParams((p) => ({ ...p, creditWindow: v }))}
                  />
                  {algo === 'tamer' && (
                    <>
                      <Slider
                        label="信用衰减"
                        value={tamerParams.creditDecay}
                        min={0}
                        max={1}
                        step={0.05}
                        format={(v) => v.toFixed(2)}
                        disabled={tamerParams.creditWindow <= 1}
                        onChange={(v) => setTamerParams((p) => ({ ...p, creditDecay: v }))}
                      />
                      <p className="muted text-xs">
                        信用窗口&gt;1 时，一次评分会按衰减权重分摊到最近几步（模拟反馈延迟）。
                      </p>
                    </>
                  )}
                  {algo === 'ai' && (
                    <p className="muted text-xs">
                      信用窗口决定额外把多少「更早一步」作为 TRACE 候选暴露给 AI（仍不含完整图）。
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Slider
                    label="α 学习率"
                    value={params.alpha}
                    min={0.05}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setParams((p) => ({ ...p, alpha: v }))}
                  />
                  <Slider
                    label="γ 折扣"
                    value={params.gamma}
                    min={0}
                    max={0.99}
                    step={0.01}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setParams((p) => ({ ...p, gamma: v }))}
                  />
                  <Slider
                    label="ε 探索"
                    value={params.epsilon}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setParams((p) => ({ ...p, epsilon: v }))}
                  />
                  <Slider
                    label="终点环境奖励"
                    value={params.goalReward}
                    min={0}
                    max={5}
                    step={0.1}
                    format={(v) => v.toFixed(1)}
                    onChange={(v) => setParams((p) => ({ ...p, goalReward: v }))}
                  />
                  <Slider
                    label="每步惩罚"
                    value={params.stepPenalty}
                    min={-1}
                    max={0}
                    step={0.01}
                    format={(v) => v.toFixed(2)}
                    onChange={(v) => setParams((p) => ({ ...p, stepPenalty: v }))}
                  />
                </>
              )}
              <Slider
                label="单局最大步数"
                value={maxSteps}
                min={10}
                max={150}
                step={1}
                onChange={setMaxSteps}
              />
              <Slider
                label="收敛连胜局数"
                value={convergeN}
                min={1}
                max={10}
                step={1}
                onChange={setConvergeN}
              />
            </div>
          </Panel>

          {algo === 'ai' && (
            <Panel title="AI API（分配 Q）">
              <p className="muted mb-3 text-xs leading-relaxed">
                与实验五共用密钥存储。模型只收到评分、文字与局部候选 Q（C1/C2…），不会收到整张图。
              </p>
              <label className="mb-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={llmConfig.useLocal || !llmConfig.apiKey}
                  onChange={(e) =>
                    setLlmConfig((c) => ({ ...c, useLocal: e.target.checked }))
                  }
                />
                本地启发式（无需密钥）
              </label>
              <button
                type="button"
                className="btn mb-3 w-full"
                onClick={() => setShowApi((v) => !v)}
              >
                {showApi ? '收起 API 字段' : '展开 API 字段'}
              </button>
              {showApi && (
                <div className="space-y-2 text-sm">
                  <label className="block">
                    <span className="muted mb-1 block text-xs">Endpoint</span>
                    <input
                      className="w-full rounded-md border border-[var(--border)] bg-[#0f1526] px-2 py-1.5 text-xs"
                      value={llmConfig.endpoint}
                      onChange={(e) =>
                        setLlmConfig((c) => ({ ...c, endpoint: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="muted mb-1 block text-xs">Model</span>
                    <input
                      className="w-full rounded-md border border-[var(--border)] bg-[#0f1526] px-2 py-1.5 text-xs"
                      value={llmConfig.model}
                      onChange={(e) =>
                        setLlmConfig((c) => ({ ...c, model: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="muted mb-1 block text-xs">API Key</span>
                    <input
                      type="password"
                      className="w-full rounded-md border border-[var(--border)] bg-[#0f1526] px-2 py-1.5 text-xs"
                      value={llmConfig.apiKey}
                      onChange={(e) =>
                        setLlmConfig((c) => ({
                          ...c,
                          apiKey: e.target.value,
                          useLocal: !e.target.value.trim(),
                        }))
                      }
                      placeholder="sk-…"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    onClick={() => {
                      const next = {
                        ...llmConfig,
                        endpoint: normalizeLlmEndpoint(llmConfig.endpoint),
                        apiKey: normalizeApiKey(llmConfig.apiKey),
                        useLocal: llmConfig.useLocal || !llmConfig.apiKey.trim(),
                      }
                      setLlmConfig(next)
                      saveLlmConfig(next)
                      setLastAiSummary(
                        next.useLocal || !next.apiKey
                          ? '已保存：本地启发式'
                          : `已保存：${next.model}`,
                      )
                    }}
                  >
                    保存 API 设置
                  </button>
                </div>
              )}
            </Panel>
          )}

          <Panel title="评分窗口">
            <p className="muted mb-3 text-xs">
              默认：到达终点自动满分（+{AUTO_GOAL_RATING}）；人工超时不更新价值表。人脑评分是线性 3
              类头：按键 1–5 训练任务一/任务二/任务三，超时用预测写入。随机模式可作 chance-level 基线。
              {algo === 'ai' ? ' AI 模式下评分窗口默认不超时，并支持文字反馈。' : ''}
            </p>

            <fieldset className="mb-3 space-y-2 border-0 p-0">
              <legend className="mb-1 text-sm font-medium">奖励来源</legend>
              {(
                [
                  {
                    id: 'human' as const,
                    label: '人工评分',
                    hint: '按键 / 点击；终点自动 +1',
                  },
                  {
                    id: 'eeg' as const,
                    label: '人脑评分（线性 3 类）',
                    hint: '1–2 任务一 / 3 任务二 / 4–5 任务三；按键训练，超时预测；终点仍 +1',
                  },
                  {
                    id: 'foundation' as const,
                    label: '基座模型服务（任务头）',
                    hint:
                      foundationHeadPred
                        ? `ordinal_rating_3 已就绪 · ${modelRuntime.latestPrediction?.model_revision ?? 'base'}`
                        : '仅接受显式 ordinal_rating_3；MI/未知分类不会转换成奖励',
                  },
                  {
                    id: 'randomKeepGoal' as const,
                    label: '随机 + 保留终点（对照）',
                    hint: '途中均匀抽 {-1…1}；终点仍自动 +1',
                  },
                  {
                    id: 'random' as const,
                    label: '完全随机',
                    hint: '每步（含终点）均匀抽 {-1…1}',
                  },
                ] as const
              ).map((opt) => (
                <label key={opt.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    className="mt-1"
                    name="reward-mode"
                    checked={rewardMode === opt.id}
                    onChange={() => setRewardMode(opt.id)}
                    disabled={running || phase === 'moving' || phase === 'rating'}
                  />
                  <span>
                    {opt.label}
                    <span className="muted mt-0.5 block text-xs">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="mb-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={infiniteWait}
                onChange={(e) => setInfiniteWait(e.target.checked)}
                disabled={
                  rewardMode !== 'human' &&
                  rewardMode !== 'eeg' &&
                  rewardMode !== 'foundation'
                }
              />
              无限等待（关闭超时）
            </label>
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={skipWaitAfterRate}
                onChange={(e) => setSkipWaitAfterRate(e.target.checked)}
                disabled={
                  infiniteWait ||
                  algo === 'ai' ||
                  (rewardMode !== 'human' &&
                    rewardMode !== 'eeg' &&
                    rewardMode !== 'foundation')
                }
              />
              <span>
                评分后跳过等待
                <span className="muted mt-0.5 block text-xs">
                  关掉后按 1–5 只记下，倒计时结束才提交，每步窗口长度固定。
                </span>
              </span>
            </label>
            <Slider
              label="评分超时 (ms)"
              value={ratingTimeout}
              min={500}
              max={5000}
              step={100}
              disabled={
                infiniteWait ||
                (rewardMode !== 'human' &&
                  rewardMode !== 'eeg' &&
                  rewardMode !== 'foundation')
              }
              onChange={setRatingTimeout}
            />

            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <p className="mb-2 text-sm font-medium">线性头状态</p>
              <p className="muted mb-2 text-xs">
                勾选进入模型的特征（改勾选会重置权重）。开局后「人脑评分」用按键训练；未开局可用下方调试。
              </p>
              <HeadFeaturePicker
                keys={headKeys}
                disabled={phase === 'rating' || phase === 'moving' || phase === 'ai_updating'}
                onChange={(next) => {
                  linearHeadRef.current!.setKeys(next)
                  linearHeadRef.current!.save()
                  setHeadKeys(linearHeadRef.current!.keys)
                  setHeadStats(linearHeadRef.current!.stats())
                  pendingFeatRef.current = null
                  setStepHeadPred(null)
                }}
              />
              <div className="mb-3 rounded-md border border-[var(--border)] bg-[#0f1526] px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="muted">样本 / 全量 CE</span>
                  <span className="font-mono">
                    n={headStats.nTrain}
                    {headStats.lastLoss != null ? ` · CE=${headStats.lastLoss.toFixed(3)}` : ''}
                    {headStats.acc != null ? ` · acc=${(headStats.acc * 100).toFixed(0)}%` : ''}
                    {` · ${headStats.arch}`}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="muted">当前预测</span>
                  <span className="font-mono">
                    {liveHeadPred
                      ? `${liveHeadPred.label} → ${liveHeadPred.rating >= 0 ? '+' : ''}${liveHeadPred.rating}`
                      : '等待特征'}
                  </span>
                </div>
                {liveHeadPred ? (
                  <div className="mt-2 grid grid-cols-3 gap-1 text-center font-mono">
                    {LINEAR_HEAD_CLASSES.map((label, i) => (
                      <span key={label} className={i === liveHeadPred.classIndex ? 'text-white' : 'muted'}>
                        {label} {(liveHeadPred.probs[i]! * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn mt-2 w-full text-xs"
                  onClick={() => {
                    linearHeadRef.current!.reset()
                    linearHeadRef.current!.save()
                    setHeadStats(linearHeadRef.current!.stats())
                  }}
                >
                  重置权重与样本
                </button>
              </div>
              <LinearHeadDebug
                keys={headKeys}
                values={features.latest?.values}
                pred={liveHeadPred}
                canTrain={!running && (phase === 'idle' || phase === 'converged')}
                hiddenSize={headStats.hiddenSize}
                useRelu={headStats.useRelu}
                lr={headStats.lr}
                archLocked={phase === 'rating' || phase === 'moving' || phase === 'ai_updating'}
                onArch={(h, relu) => {
                  linearHeadRef.current!.setArch(h, relu)
                  linearHeadRef.current!.save()
                  setHeadStats(linearHeadRef.current!.stats())
                  pendingFeatRef.current = null
                  setStepHeadPred(null)
                }}
                onLr={(nextLr) => {
                  linearHeadRef.current!.setLr(nextLr)
                  linearHeadRef.current!.save()
                  setHeadStats(linearHeadRef.current!.stats())
                }}
                onRefit={() => {
                  linearHeadRef.current!.refit()
                  linearHeadRef.current!.save()
                  setHeadStats(linearHeadRef.current!.stats())
                }}
                onLabel={(classIndex) => {
                  const head = linearHeadRef.current!
                  const x = extractLinearFeatures(latestValuesRef.current, headKeysRef.current)
                  if (!x || x.length !== head.nFeat) return null
                  const before = head.predict(x)
                  const loss = head.train(x, classIndex)
                  head.save()
                  setHeadStats(head.stats())
                  loggerRef.current.log('linear_head_debug', {
                    classIndex,
                    label: LINEAR_HEAD_CLASSES[classIndex],
                    pred: before.label,
                    probs: before.probs,
                    loss,
                    nTrain: head.nTrain,
                    arch: head.stats().arch,
                  })
                  return loss
                }}
              />
            </div>

            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <label className="mb-2 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={noiseEnabled}
                  onChange={(e) => setNoiseEnabled(e.target.checked)}
                />
                <span>
                  评分噪声（模拟脑电解码）
                  <span className="muted mt-0.5 block text-xs">
                    对最终评分再叠高斯 / 等级翻转（随机模式上也可叠加）。
                  </span>
                </span>
              </label>
              <div className="space-y-3">
                <Slider
                  label="高斯 σ"
                  value={noiseSigma}
                  min={0.05}
                  max={0.8}
                  step={0.05}
                  format={(v) => v.toFixed(2)}
                  disabled={!noiseEnabled}
                  onChange={setNoiseSigma}
                />
                <Slider
                  label="等级翻转概率"
                  value={noiseFlipProb}
                  min={0}
                  max={0.4}
                  step={0.01}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  disabled={!noiseEnabled}
                  onChange={setNoiseFlipProb}
                />
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="学习曲线（每局步数 vs 该局最短路）" className="mt-4">
        {chartData.length === 0 ? (
          <p className="muted text-sm">完成至少一局后显示曲线。每局起点不同，最短路也会变化。</p>
        ) : (
          <LineChart
            data={chartData}
            xKey="episode"
            series={[
              { key: 'steps', name: '步数', color: '#5b8cff' },
              { key: 'shortest', name: '本局最短路', color: '#38d39f' },
            ]}
          />
        )}
      </Panel>

      <div className="mt-4">
        <LiveEegBadge className="mb-3" />
      </div>
      <FeatureMonitorPanel
        latest={features.latest}
        history={features.history}
        analyzing={features.analyzing}
        enabledIds={features.enabledIds}
        onEnabledChange={features.onEnabledChange}
        origin={features.origin}
        note={
          features.origin === 'live'
            ? '实时 EEG：人脑评分用线性 3 类头，按键训练、超时预测。勾选与其它页共用。'
            : features.origin === 'stale'
              ? '实时流已断开，特征停在最后一帧（不会改用合成数据）。请回采集页重新开流。'
              : '合成 EEG 特征流；采集页开流后会自动切到实时。勾选与其它页共用。'
        }
      />
    </div>
  )
}

export default RlGraphExperiment
