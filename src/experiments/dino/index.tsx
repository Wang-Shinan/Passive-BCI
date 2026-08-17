import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { ManualSignalSource } from '../../lib/signal/manual'
import { FeatureMonitorPanel, SignalModeControls, useStressControl } from '../../lib/features'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import { STRESS_KEY_LEVELS } from '../tetris/StressPanel'
import {
  DINO_DUCK_H,
  DINO_H,
  DINO_W,
  DINO_X,
  GROUND_Y,
  createDinoGame,
  jumpDino,
  makeDinoRng,
  setDucking,
  startDinoRun,
  stepDino,
  stressSpawnMult,
  stressSpeedMult,
  toggleDinoPause,
  type DinoEvent,
  type DinoGameState,
  type Obstacle,
} from './dinoEngine'
import './dino.css'

function drawDino(
  ctx: CanvasRenderingContext2D,
  state: DinoGameState,
  night: boolean,
) {
  const h = state.ducking ? DINO_DUCK_H : DINO_H
  const x = DINO_X
  const y = GROUND_Y - state.dinoY - h
  const color = night ? '#f1f1f1' : '#535353'

  ctx.fillStyle = color
  if (state.ducking) {
    ctx.fillRect(x + 4, y + 8, DINO_W - 6, h - 10)
    ctx.fillRect(x + 22, y + 2, 18, 12)
    ctx.fillRect(x, y + h - 8, 10, 6)
    ctx.fillRect(x + 14, y + h - 8, 10, 6)
  } else {
    // Body
    ctx.fillRect(x + 8, y + 14, 26, 26)
    // Head
    ctx.fillRect(x + 26, y + 2, 18, 16)
    ctx.fillRect(x + 30, y + 6, 4, 4) // eye socket later
    // Tail
    ctx.fillRect(x, y + 20, 10, 8)
    // Legs (run cycle)
    const leg = state.grounded && state.status === 'running' ? Math.floor(state.frame / 6) % 2 : 0
    if (leg === 0) {
      ctx.fillRect(x + 12, y + 38, 8, 10)
      ctx.fillRect(x + 26, y + 40, 8, 8)
    } else {
      ctx.fillRect(x + 12, y + 40, 8, 8)
      ctx.fillRect(x + 26, y + 38, 8, 10)
    }
    // Eye
    ctx.fillStyle = night ? '#202020' : '#f7f7f7'
    ctx.fillRect(x + 36, y + 6, 4, 4)
  }

  if (state.status === 'gameover') {
    ctx.fillStyle = '#ff5d6c'
    ctx.fillRect(x + 34, y + 4, 6, 6)
  }
}

function drawCactus(ctx: CanvasRenderingContext2D, o: Obstacle, night: boolean) {
  const color = night ? '#f1f1f1' : '#535353'
  const x = o.x
  const y = GROUND_Y - o.y - o.h
  ctx.fillStyle = color
  if (o.kind === 'cactus-s') {
    ctx.fillRect(x + 6, y, 6, o.h)
    ctx.fillRect(x, y + 10, 6, 6)
    ctx.fillRect(x + 12, y + 16, 6, 6)
  } else if (o.kind === 'cactus-m') {
    ctx.fillRect(x + 10, y, 8, o.h)
    ctx.fillRect(x, y + 12, 10, 8)
    ctx.fillRect(x + 18, y + 18, 10, 8)
    ctx.fillRect(x, y + 12, 4, 18)
    ctx.fillRect(x + 24, y + 18, 4, 16)
  } else {
    ctx.fillRect(x + 8, y, 8, o.h)
    ctx.fillRect(x + 22, y + 6, 8, o.h - 6)
    ctx.fillRect(x, y + 14, 10, 8)
    ctx.fillRect(x + 30, y + 20, 10, 8)
    ctx.fillRect(x, y + 14, 4, 20)
    ctx.fillRect(x + 36, y + 20, 4, 18)
  }
}

function drawBird(ctx: CanvasRenderingContext2D, o: Obstacle, frame: number, night: boolean) {
  const color = night ? '#f1f1f1' : '#535353'
  const x = o.x
  const y = GROUND_Y - o.y - o.h
  const flap = Math.floor(frame / 8) % 2
  ctx.fillStyle = color
  ctx.fillRect(x + 10, y + 10, 22, 10)
  ctx.fillRect(x + 28, y + 6, 10, 8)
  if (flap === 0) {
    ctx.fillRect(x + 14, y, 14, 10)
  } else {
    ctx.fillRect(x + 14, y + 16, 14, 10)
  }
}

function renderFrame(
  ctx: CanvasRenderingContext2D,
  state: DinoGameState,
  width: number,
  height: number,
) {
  const night = state.score >= 700 && Math.floor(state.score / 700) % 2 === 1
  ctx.fillStyle = night ? '#202020' : '#f7f7f7'
  ctx.fillRect(0, 0, width, height)

  // Ground
  const gy = GROUND_Y
  ctx.strokeStyle = night ? '#f1f1f1' : '#535353'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, gy + 1)
  ctx.lineTo(width, gy + 1)
  ctx.stroke()

  ctx.fillStyle = night ? '#f1f1f1' : '#535353'
  for (let i = -1; i < width / 24 + 2; i++) {
    const x = i * 24 - state.groundOffset
    ctx.fillRect(x, gy + 4, 2, 2)
    ctx.fillRect(x + 10, gy + 7, 3, 2)
  }

  // Clouds
  ctx.globalAlpha = night ? 0.25 : 0.35
  for (let i = 0; i < 3; i++) {
    const cx = ((width * 0.2 * i + state.distance * 0.05) % (width + 80)) - 40
    const cy = 28 + i * 18
    ctx.fillRect(cx, cy, 28, 8)
    ctx.fillRect(cx + 8, cy - 6, 18, 8)
  }
  ctx.globalAlpha = 1

  for (const o of state.obstacles) {
    if (o.kind === 'bird') drawBird(ctx, o, state.frame, night)
    else drawCactus(ctx, o, night)
  }

  drawDino(ctx, state, night)

  // Score
  ctx.fillStyle = night ? '#f1f1f1' : '#535353'
  ctx.font = 'bold 16px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'right'
  const hi = `HI ${String(state.bestScore).padStart(5, '0')}`
  const sc = String(state.score).padStart(5, '0')
  ctx.fillText(`${hi}  ${sc}`, width - 16, 28)

  if (state.status === 'idle') {
    ctx.textAlign = 'center'
    ctx.font = 'bold 22px "IBM Plex Sans", sans-serif'
    ctx.fillText('小恐龙', width / 2, height * 0.42)
    ctx.font = '14px "IBM Plex Sans", sans-serif'
    ctx.fillText('空格 / ↑ 开始并跳跃 · ↓ 俯身', width / 2, height * 0.42 + 28)
  } else if (state.status === 'paused') {
    ctx.fillStyle = night ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.55)'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = night ? '#f1f1f1' : '#535353'
    ctx.textAlign = 'center'
    ctx.font = 'bold 24px "IBM Plex Sans", sans-serif'
    ctx.fillText('已暂停', width / 2, height * 0.45)
  } else if (state.status === 'gameover') {
    ctx.textAlign = 'center'
    ctx.font = 'bold 22px "IBM Plex Sans", sans-serif'
    ctx.fillStyle = night ? '#f1f1f1' : '#535353'
    ctx.fillText('GAME OVER', width / 2, 64)
    ctx.font = '14px "IBM Plex Sans", sans-serif'
    ctx.fillText('按空格重新开始', width / 2, 88)
  }
}

export function DinoExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [game, setGame] = useState<DinoGameState>(() => createDinoGame())
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
    features,
  } = useStressControl({ initial: 40 })
  const [notice, setNotice] = useState('空格开始。压力越高：跑得越快、障碍越密、飞鸟越多。')

  const loggerRef = useRef(new SessionLogger('dino', subjectId))
  const signalRef = useRef(new ManualSignalSource({ kind: 'stress', initial: 40 }))
  const gameRef = useRef(game)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  const stressRef = useRef(stress)
  const rngRef = useRef(makeDinoRng(game.seed))
  const canvasWRef = useRef(800)

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    stressRef.current = stress
    const sample = signalRef.current.push(stress)
    loggerRef.current.log('stress', { value: sample.value, origin: mode })
  }, [stress, mode])

  const commitGame = useCallback((next: DinoGameState) => {
    gameRef.current = next
    setGame(next)
  }, [])

  const handleEvents = useCallback((events: DinoEvent[]) => {
    for (const event of events) {
      loggerRef.current.log(event.type, event.data)
      if (event.type === 'game_start') {
        setNotice('奔跑中… 空格跳跃 · ↓ 俯身躲飞鸟 · P 暂停')
      } else if (event.type === 'milestone') {
        setNotice(`里程碑 ${event.data.score}`)
      } else if (event.type === 'gameover') {
        setNotice(`撞到了。得分 ${event.data.score} · 跳跃 ${event.data.jumps} 次`)
      }
    }
  }, [])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    renderFrame(ctx, gameRef.current, canvas.width / dpr, canvas.height / dpr)
  }, [])

  useEffect(() => {
    const frame = (timestamp: number) => {
      if (!lastFrameRef.current) lastFrameRef.current = timestamp
      const dtS = Math.min(0.05, (timestamp - lastFrameRef.current) / 1000)
      lastFrameRef.current = timestamp
      if (gameRef.current.status === 'running') {
        const result = stepDino(
          gameRef.current,
          dtS,
          stressRef.current,
          canvasWRef.current,
          rngRef.current,
        )
        if (result.events.length) handleEvents(result.events)
        gameRef.current = result.state
        if (result.state.status === 'gameover' || result.events.some((e) => e.type === 'milestone')) {
          setGame(result.state)
        }
      }
      paint()
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafRef.current)
  }, [handleEvents, paint])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const resize = () => {
      const rect = stage.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(320, Math.floor(rect.width))
      const h = 220
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvasWRef.current = w
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [paint])

  const beginRun = useCallback(() => {
    loggerRef.current.clear()
    const result = startDinoRun(gameRef.current, stressRef.current)
    rngRef.current = makeDinoRng(result.state.seed)
    handleEvents(result.events)
    commitGame(result.state)
  }, [commitGame, handleEvents])

  const tryJump = useCallback(() => {
    const current = gameRef.current
    if (current.status === 'idle' || current.status === 'gameover') {
      beginRun()
      // small hop after start
      queueMicrotask(() => {
        const hopped = jumpDino(gameRef.current)
        if (hopped.events.length) {
          handleEvents(hopped.events)
          commitGame(hopped.state)
        }
      })
      return
    }
    if (current.status === 'paused') {
      commitGame(toggleDinoPause(current))
      return
    }
    const result = jumpDino(current)
    if (!result.events.length) return
    handleEvents(result.events)
    commitGame(result.state)
  }, [beginRun, commitGame, handleEvents])

  const onPause = useCallback(() => {
    const next = toggleDinoPause(gameRef.current)
    commitGame(next)
    loggerRef.current.log(next.status === 'paused' ? 'pause' : 'resume')
  }, [commitGame])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return
      }
      if (event.key in STRESS_KEY_LEVELS) {
        if (mode !== 'manual') return
        event.preventDefault()
        const value = STRESS_KEY_LEVELS[event.key]!
        setStress(value)
        setNotice(`压力档位 ${event.key} → ${value}`)
        return
      }
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        onPause()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') {
        event.preventDefault()
        const result = setDucking(gameRef.current, true)
        if (result.events.length) {
          handleEvents(result.events)
          commitGame(result.state)
        }
        return
      }
      if (
        event.key === ' ' ||
        event.key === 'ArrowUp' ||
        event.key === 'w' ||
        event.key === 'W'
      ) {
        event.preventDefault()
        if (!event.repeat) tryJump()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') {
        event.preventDefault()
        const result = setDucking(gameRef.current, false)
        if (result.events.length) {
          handleEvents(result.events)
          commitGame(result.state)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [commitGame, handleEvents, onPause, tryJump, mode, setStress])

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回实验列表
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="m-0 text-2xl font-semibold">小恐龙</h1>
            <span className="chip">Chrome Dino</span>
          </div>
          <p className="muted mt-2 max-w-2xl text-sm">
            经典跑酷：跳跃躲仙人掌、俯身躲飞鸟。压力经{' '}
            <code className="rounded bg-[#10182b] px-1.5 py-0.5 text-xs">ManualSignalSource</code>{' '}
            注入，调节速度与障碍密度。
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
        />
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <main className="space-y-4">
          <div className="dino-hud">
            <div>
              <span>得分</span>
              <strong>{game.score}</strong>
            </div>
            <div>
              <span>最高</span>
              <strong>{game.bestScore}</strong>
            </div>
            <div>
              <span>速度</span>
              <strong>{game.speed.toFixed(0)}</strong>
            </div>
            <div>
              <span>跳跃</span>
              <strong>{game.jumps}</strong>
            </div>
          </div>

          <div
            ref={stageRef}
            className={`dino-stage status-${game.status}`}
            onPointerDown={(e) => {
              e.preventDefault()
              tryJump()
            }}
          >
            <canvas ref={canvasRef} className="dino-canvas" />
          </div>

          <div className="rounded-xl border border-[#2a3550] bg-[#0d1425] px-4 py-3 text-sm">
            {notice}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={beginRun}>
              {game.status === 'idle' ? '开始' : '重新开始'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={game.status === 'idle' || game.status === 'gameover'}
              onClick={onPause}
            >
              {game.status === 'paused' ? '继续' : '暂停'}
            </button>
            <span className="chip">空格跳 · ↓ 俯身 · 1–5 压力 · P 暂停</span>
          </div>
        </main>

        <aside className="space-y-4">
          <Panel
            title="压力信号"
            actions={
              <span className="chip" style={{ color: mode !== 'manual' ? 'var(--accent-2)' : 'var(--muted)' }}>
                {mode === 'live' ? '实时 EEG' : mode === 'features' ? '演示数据' : '手动'}
              </span>
            }
          >
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
            <Slider
              label={mode === 'live' ? '压力（实时 EEG，只读）' : mode === 'features' ? '压力（演示输出，只读）' : '压力'}
              value={mode !== 'manual' ? Math.round(stress * 10) / 10 : Math.round(stress)}
              min={0}
              max={100}
              step={mode !== 'manual' ? 0.1 : 1}
              format={mode !== 'manual' ? (v) => v.toFixed(1) : undefined}
              onChange={setStress}
              disabled={mode !== 'manual'}
            />
            <div className="mt-3 flex gap-1.5">
              {([0, 25, 50, 75, 100] as const).map((value, i) => {
                const key = i + 1
                const active = Math.abs(stress - value) < 0.5
                return (
                  <button
                    key={key}
                    type="button"
                    className={`btn flex-1 px-1 py-2 text-xs ${active ? 'btn-primary' : ''}`}
                    disabled={mode !== 'manual'}
                    onClick={() => {
                      setStress(value)
                      setNotice(`压力档位 ${key} → ${value}`)
                    }}
                  >
                    <span className="font-mono text-sm">{key}</span>
                    <span className="muted mt-0.5 block">{value}</span>
                  </button>
                )
              })}
            </div>
            <p className="muted mb-0 mt-3 text-xs leading-relaxed">
              {mode === 'live'
                ? '实时 EEG 调控中；点「手动输入」接管。'
                : mode === 'features'
                  ? '演示数据调控中；点「手动输入」接管。'
                  : `压力越高：速度 ×${stressSpeedMult(stress).toFixed(2)}，刷新间隔 ×${stressSpawnMult(stress).toFixed(2)}。`}
            </p>
          </Panel>

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
                  ? `实时 EEG：${driverFeature} → 压力。`
                  : '已选实时 EEG，等待采集页样本。'
                : mode === 'features'
                  ? `演示数据：${driverFeature} → 压力。点「手动输入」接管。`
                  : '手动模式；可切「演示数据」或「实时 EEG」。'
            }
          />

          <Panel title="玩法">
            <ul className="muted m-0 space-y-2 pl-4 text-sm">
              <li>空格 / ↑ / 点击：跳跃（开局也用它）</li>
              <li>↓：俯身躲避低飞鸟</li>
              <li>分数随跑动距离增加；夜间模式在高分段切换</li>
              <li>碰撞后可导出本局跳跃 / 命中日志</li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  )
}

export default DinoExperiment
