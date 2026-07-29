import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { mulberry32 } from '../../lib/rng'
import { ManualSignalSource } from '../../lib/signal/manual'
import { easeInOutCubic } from '../../lib/timing'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { LineChart } from '../../lib/ui/LineChart'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
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

const ANIM_MS = 400
const W = 720
const H = 480
/** Auto human-rating when the agent steps onto the goal. */
const AUTO_GOAL_RATING = 1

type Phase = 'idle' | 'moving' | 'rating' | 'converged'

export function RlGraphExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [mode, setMode] = useState<GraphMode>('graph')
  const [nodeCount, setNodeCount] = useState(24)
  const [gridCols, setGridCols] = useState(6)
  const [gridRows, setGridRows] = useState(5)
  const [density, setDensity] = useState(1.8)
  const [leafStartOnly, setLeafStartOnly] = useState(false)
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
  const [ratingTimeout, setRatingTimeout] = useState(1500)
  const [maxSteps, setMaxSteps] = useState(60)
  const [convergeN, setConvergeN] = useState(3)
  const [params, setParams] = useState<QParams>({
    alpha: 0.4,
    gamma: 0.9,
    epsilon: 0.2,
    stepPenalty: -0.05,
    goalReward: 1,
  })

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

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

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
      setAnimFrom(null)
      setAnimTo(null)
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
      })
    },
    [mode, nodeCount, gridCols, gridRows, density, spawnEpisode],
  )

  const resetQ = () => {
    const fresh = createQTable()
    setQTable(fresh)
    qTableRef.current = fresh
    setEpisode(1)
    episodeRef.current = 1
    setEpisodeSteps([])
    setShortestStreak(0)
    shortestStreakRef.current = 0
    setRunning(false)
    spawnEpisode(graphRef.current, 1)
    loggerRef.current.log('reset_q')
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

  const applyReward = useCallback(
    (humanReward: number, auto = false) => {
      const pending = pendingRef.current
      if (!pending || phaseRef.current !== 'rating') return

      const g = graphRef.current
      signalRef.current.push(humanReward, {
        from: pending.from,
        to: pending.to,
        auto,
      })
      const done = pending.to === g.goal
      const nextSteps = stepsRef.current
      const ep = episodeRef.current
      const epShortest = bfsDistance(g, episodeStartRef.current, g.goal)

      setQTable((prev) => {
        const copy: QTable = { values: new Map(prev.values) }
        tdUpdate(copy, g, pending.from, pending.to, pending.to, humanReward, params, done)
        qTableRef.current = copy
        return copy
      })

      loggerRef.current.log('rating', {
        from: pending.from,
        to: pending.to,
        humanReward,
        auto,
        done,
        episode: ep,
        steps: nextSteps,
      })

      pendingRef.current = null

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
    [params, maxSteps, convergeN, spawnEpisode],
  )

  const takeStep = useCallback(async () => {
    if (phaseRef.current !== 'idle') return

    const g = graphRef.current
    const from = agentPosRef.current
    const action = epsilonGreedy(
      qTableRef.current,
      g,
      from,
      params.epsilon,
      rngRef.current,
    )
    if (action === null) return

    pendingRef.current = { from, to: action }
    loggerRef.current.log('step_chosen', {
      from,
      to: action,
      episode: episodeRef.current,
      steps: stepsRef.current,
    })
    await animateMove(from, action)
    stepsRef.current += 1
    setSteps(stepsRef.current)

    // Reaching the goal: auto high rating, skip human prompt
    if (action === g.goal) {
      setPhase('rating')
      // Defer so phaseRef updates before applyReward checks it
      queueMicrotask(() => {
        phaseRef.current = 'rating'
        applyReward(AUTO_GOAL_RATING, true)
      })
      return
    }

    setPhase('rating')
  }, [params.epsilon, animateMove, applyReward])

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
            {mode === 'grid' ? '网格' : '图'}模式 · {graph.nodes.length} 节点 · 本局最短路{' '}
            {Number.isFinite(shortest) ? shortest : '—'} 步 · 种子 {seed}
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
            open={phase === 'rating' && agentPos !== graph.goal}
            timeoutMs={ratingTimeout}
            infinite={infiniteWait}
            onRate={(v) => applyReward(v, false)}
            onTimeout={() => applyReward(0, false)}
          />
          {phase === 'converged' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
              <div className="panel mx-auto max-w-sm p-6 text-center">
                <h3 className="m-0 text-xl">已收敛</h3>
                <p className="muted mt-2 text-sm">
                  连续 {convergeN} 局走出该局最短路。
                </p>
                <button type="button" className="btn btn-primary mt-4" onClick={resetQ}>
                  重置 Q 表再来
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
              <button type="button" className="btn" onClick={resetQ}>
                重置 Q
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
              <div className="chip justify-center">起点 #{episodeStart}</div>
            </div>
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

          <Panel title="评分窗口">
            <p className="muted mb-3 text-xs">
              到达终点时自动给出满分评分（+{AUTO_GOAL_RATING}），不再等待人工输入。
            </p>
            <label className="mb-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={infiniteWait}
                onChange={(e) => setInfiniteWait(e.target.checked)}
              />
              无限等待（关闭超时）
            </label>
            <Slider
              label="评分超时 (ms)"
              value={ratingTimeout}
              min={500}
              max={5000}
              step={100}
              disabled={infiniteWait}
              onChange={setRatingTimeout}
            />
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
    </div>
  )
}

export default RlGraphExperiment
