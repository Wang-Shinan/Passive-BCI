import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { mulberry32 } from '../../lib/rng'
import { ManualSignalSource } from '../../lib/signal/manual'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { LineChart } from '../../lib/ui/LineChart'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import { Board, NextPreview } from './Board'
import {
  createGame,
  hardDrop,
  move,
  rotate,
  softDrop,
  gravityTick,
  type GameEvent,
  type GameState,
} from './engine'
import {
  defaultGravityConfig,
  gravityToIntervalMs,
  initGravityState,
  updateGravity,
  type GravityConfig,
  type GravityMode,
  type GravityState,
} from './gravity'
import { StressPanel } from './StressPanel'
import { useStressChannel } from './useStressChannel'

interface TracePoint {
  t: number
  stress: number
  gravity: number
}

export function TetrisExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [seed] = useState(() => (Math.random() * 0xffffffff) >>> 0)
  const rngRef = useRef(mulberry32(seed))
  const [state, setState] = useState<GameState>(() => createGame(seed))
  const { stress, setStress } = useStressChannel(40)
  const [cfg, setCfg] = useState<GravityConfig>(() => defaultGravityConfig())
  const gravityRef = useRef<GravityState>(initGravityState(defaultGravityConfig()))
  const [gravityDisplay, setGravityDisplay] = useState(gravityRef.current.smoothed)
  const [trace, setTrace] = useState<TracePoint[]>([])
  const loggerRef = useRef(new SessionLogger('tetris', subjectId))
  const signalRef = useRef(new ManualSignalSource({ kind: 'stress', initial: 40 }))
  const dropAccRef = useRef(0)
  const lastTsRef = useRef(0)
  const t0Ref = useRef(performance.now())
  const stateRef = useRef(state)
  const stressRef = useRef(stress)
  const cfgRef = useRef(cfg)

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    stressRef.current = stress
    signalRef.current.push(stress)
  }, [stress])

  useEffect(() => {
    cfgRef.current = cfg
  }, [cfg])

  const applyResult = useCallback((next: GameState, events: GameEvent[]) => {
    setState(next)
    for (const ev of events) {
      loggerRef.current.log(ev.type, ev as unknown as Record<string, unknown>)
    }
  }, [])

  // Game loop
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

      const s = stateRef.current
      if (!s.gameOver && !s.paused && s.piece) {
        dropAccRef.current += dt
        const interval = gravityToIntervalMs(gState.smoothed)
        while (dropAccRef.current >= interval) {
          dropAccRef.current -= interval
          const result = gravityTick(stateRef.current, rngRef.current)
          stateRef.current = result.state
          applyResult(result.state, result.events)
          if (result.state.gameOver) break
        }
      }

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [applyResult])

  // Keyboard controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' ', 'c', 'C', 'p', 'P', 'r', 'R'].includes(e.key)) {
        e.preventDefault()
      }
      const s = stateRef.current
      if (e.key === 'p' || e.key === 'P') {
        setState((prev) => ({ ...prev, paused: !prev.paused }))
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        restart()
        return
      }
      if (s.gameOver || s.paused) return

      let result
      if (e.key === 'ArrowLeft') result = move(s, -1, rngRef.current)
      else if (e.key === 'ArrowRight') result = move(s, 1, rngRef.current)
      else if (e.key === 'ArrowDown') result = softDrop(s, rngRef.current)
      else if (e.key === 'ArrowUp' || e.key === 'x' || e.key === 'X') result = rotate(s, 1, rngRef.current)
      else if (e.key === 'z' || e.key === 'Z') result = rotate(s, -1, rngRef.current)
      else if (e.key === ' ') result = hardDrop(s, rngRef.current)
      else return

      stateRef.current = result.state
      applyResult(result.state, result.events)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyResult])

  const restart = () => {
    const nextSeed = (Math.random() * 0xffffffff) >>> 0
    rngRef.current = mulberry32(nextSeed)
    const g = createGame(nextSeed)
    stateRef.current = g
    setState(g)
    gravityRef.current = initGravityState(cfgRef.current)
    dropAccRef.current = 0
    lastTsRef.current = 0
    t0Ref.current = performance.now()
    setTrace([])
    loggerRef.current.log('restart', { seed: nextSeed })
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-1 text-2xl font-semibold">实验二 · 压力自适应俄罗斯方块</h1>
          <p className="muted m-0 mt-1 text-sm">
            ←→ 移动 · ↑/X 顺时针 · Z 逆时针 · ↓ 软降 · 空格硬降 · P 暂停 · R 重开
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[auto_1fr_300px]">
        <div className="flex justify-center">
          <Board state={state} />
        </div>

        <div className="space-y-4">
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
                <button type="button" className="btn" onClick={() => setState((s) => ({ ...s, paused: !s.paused }))}>
                  {state.paused ? '继续' : '暂停'}
                </button>
                <button type="button" className="btn btn-primary" onClick={restart}>
                  重开
                </button>
              </div>
            </div>
          </Panel>

          <Panel title="压力 ↔ 重力 映射">
            <div className="mb-3 flex gap-2">
              {(['regulate', 'challenge'] as GravityMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn ${cfg.mode === m ? 'btn-primary' : ''}`}
                  onClick={() => setCfg((c) => ({ ...c, mode: m }))}
                >
                  {m === 'regulate' ? '调节模式 (PI)' : '挑战模式'}
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
              <p className="muted text-sm">压力越高，下落越快（二次曲线映射）。</p>
            )}
            <div className="mt-3 space-y-3">
              <Slider
                label="最小重力"
                value={cfg.minGravity}
                min={0.2}
                max={3}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => setCfg((c) => ({ ...c, minGravity: v }))}
              />
              <Slider
                label="最大重力"
                value={cfg.maxGravity}
                min={2}
                max={15}
                step={0.5}
                format={(v) => v.toFixed(1)}
                onChange={(v) => setCfg((c) => ({ ...c, maxGravity: v }))}
              />
              <Slider
                label="平滑系数"
                value={cfg.smooth}
                min={0.02}
                max={0.5}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => setCfg((c) => ({ ...c, smooth: v }))}
              />
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

        <StressPanel stress={stress} onChange={setStress} />
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
