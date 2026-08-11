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
  advanceBoardAnim,
  advanceFall,
  createGame,
  hardDrop,
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
import { StressPanel } from './StressPanel'
import { useStressBroadcast } from './useStressBroadcast'

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
  const {
    mode,
    setMode,
    driverFeature,
    setDriverFeature,
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

  useEffect(() => {
    if (!cascadeFlash) return
    const id = window.setTimeout(() => setCascadeFlash(null), 1200)
    return () => clearTimeout(id)
  }, [cascadeFlash])

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
      }

      const s = stateRef.current
      if (!s.gameOver && !s.paused) {
        if (s.anim) {
          const result = advanceBoardAnim(s, rngRef.current, dt)
          applyResult(result.state, result.events)
        } else if (s.piece) {
          const speed = softDropHeldRef.current
            ? Math.max(gState.smoothed, 22)
            : gState.smoothed
          const result = softDropHeldRef.current
            ? softDropBurst(s, rngRef.current, dtSec, speed)
            : advanceFall(s, rngRef.current, dtSec, speed, false)
          applyResult(result.state, result.events)
        }
      }

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [applyResult])

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
          return next
        })
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        restart()
        return
      }
      if (e.key === 'ArrowDown') {
        softDropHeldRef.current = true
        return
      }
      if (s.gameOver || s.paused || s.anim) return

      let result
      if (e.key === 'ArrowLeft') result = move(s, -1, rngRef.current)
      else if (e.key === 'ArrowRight') result = move(s, 1, rngRef.current)
      else if (e.key === 'ArrowUp' || e.key === 'x' || e.key === 'X') result = rotate(s, 1, rngRef.current)
      else if (e.key === 'z' || e.key === 'Z') result = rotate(s, -1, rngRef.current)
      else if (e.key === ' ') result = hardDrop(s, rngRef.current)
      else return

      applyResult(result.state, result.events)
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
  }, [applyResult])

  const restart = () => {
    const nextSeed = (Math.random() * 0xffffffff) >>> 0
    rngRef.current = mulberry32(nextSeed)
    const g = createGame(nextSeed)
    stateRef.current = g
    setState(g)
    gravityRef.current = initGravityState(cfgRef.current)
    lastTsRef.current = 0
    t0Ref.current = performance.now()
    softDropHeldRef.current = false
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
        <div className="relative flex justify-center">
          <Board state={state} />
          {cascadeFlash && (
            <div className="pointer-events-none absolute inset-x-0 top-6 text-center">
              <span className="inline-block rounded-full border border-[#f5a52466] bg-[#1a1520ee] px-3 py-1 text-sm font-semibold text-[#f5a524] shadow-lg">
                {cascadeFlash}
              </span>
            </div>
          )}
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
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setState((s) => {
                      const next = { ...s, paused: !s.paused }
                      stateRef.current = next
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
              mode === 'features'
                ? `演示数据调控中（${driverFeature}）→ 压力应持续波动。点「手动输入」接管。`
                : '手动模式：合成 EEG 随压力调制。可切「演示数据」让压力自动波动。'
            }
        />
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
