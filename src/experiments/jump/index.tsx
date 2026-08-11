import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { mulberry32 } from '../../lib/rng'
import { ManualSignalSource } from '../../lib/signal/manual'
import { FeatureMonitorPanel, SignalModeControls, useStressControl } from '../../lib/features'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import {
  MAX_HOLD_MS,
  PERFECT_HIT_DIST,
  WORLD_SCALE,
  beginCharge,
  createGame,
  isCircularPlatform,
  jumpDistance,
  landHitExtent,
  powerFromHold,
  releaseJump,
  stepGame,
  stressGapMult,
  stressSizeMult,
  togglePause,
  worldToScreen,
  type GameState,
  type JumpEvent,
  type Platform,
} from './jumpEngine'
import './jump.css'

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) + amount)))
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) + amount)))
  const b = Math.max(0, Math.min(255, Math.round((n & 255) + amount)))
  return `rgb(${r},${g},${b})`
}

function drawPlatform(
  ctx: CanvasRenderingContext2D,
  plat: Platform,
  camX: number,
  camZ: number,
  originX: number,
  originY: number,
  squash = 1,
) {
  const top = worldToScreen(plat.x, plat.z, plat.height * squash, camX, camZ)
  const base = worldToScreen(plat.x, plat.z, 0, camX, camZ)
  const r = plat.size * WORLD_SCALE
  const h = base.sy - top.sy

  ctx.save()
  ctx.translate(originX + top.sx, originY + top.sy)

  if (isCircularPlatform(plat.kind)) {
    ctx.fillStyle = plat.color
    ctx.beginPath()
    ctx.ellipse(0, h * 0.15, r * 0.95, r * 0.42, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(-r * 0.95, 0, r * 1.9, h)
    ctx.fillStyle = plat.topColor
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 0.95, r * 0.42, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.stroke()
  } else {
    const hw = r
    const hh = r * 0.5 * 1.15
    ctx.fillStyle = shade(plat.color, -18)
    ctx.beginPath()
    ctx.moveTo(-hw, hh * 0.15)
    ctx.lineTo(0, hh * 0.55 + h * 0.15)
    ctx.lineTo(0, hh * 0.55 + h)
    ctx.lineTo(-hw, hh * 0.15 + h)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = shade(plat.color, -8)
    ctx.beginPath()
    ctx.moveTo(hw, hh * 0.15)
    ctx.lineTo(0, hh * 0.55 + h * 0.15)
    ctx.lineTo(0, hh * 0.55 + h)
    ctx.lineTo(hw, hh * 0.15 + h)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = plat.topColor
    ctx.beginPath()
    ctx.moveTo(0, -hh * 0.35)
    ctx.lineTo(hw, hh * 0.15)
    ctx.lineTo(0, hh * 0.65)
    ctx.lineTo(-hw, hh * 0.15)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.1)'
    ctx.stroke()

    if (plat.kind === 'music') {
      ctx.fillStyle = '#333'
      ctx.font = `${Math.max(12, r * 0.55)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('♪', 0, r * 0.22)
    } else if (plat.kind === 'gift') {
      ctx.fillStyle = '#c62828'
      ctx.fillRect(-r * 0.28, -r * 0.08, r * 0.56, r * 0.34)
      ctx.fillStyle = '#ffd54f'
      ctx.fillRect(-r * 0.06, -r * 0.08, r * 0.12, r * 0.34)
      ctx.fillRect(-r * 0.28, r * 0.05, r * 0.56, r * 0.08)
    }
  }

  ctx.restore()
}

/**
 * Hit overlays drawn in the same local frame as the visible top,
 * so land/perfect rings sit on the platform face (not a larger true-iso footprint).
 */
function drawHitBounds(
  ctx: CanvasRenderingContext2D,
  plat: Platform,
  camX: number,
  camZ: number,
  originX: number,
  originY: number,
  squash = 1,
  highlight = false,
) {
  const top = worldToScreen(plat.x, plat.z, plat.height * squash, camX, camZ)
  const r = plat.size * WORLD_SCALE
  const landFactor = landHitExtent(plat) / Math.max(1e-6, plat.size) // ~0.95
  const perfectFactor = Math.min(0.95, PERFECT_HIT_DIST / Math.max(1e-6, plat.size))

  ctx.save()
  ctx.translate(originX + top.sx, originY + top.sy)

  const strokeLand = () => {
    if (isCircularPlatform(plat.kind)) {
      ctx.beginPath()
      ctx.ellipse(0, 0, r * landFactor, r * landFactor * (0.42 / 0.95), 0, 0, Math.PI * 2)
    } else {
      const hw = r * landFactor
      const hh = r * landFactor * 0.5 * 1.15
      ctx.beginPath()
      ctx.moveTo(0, -hh * 0.35)
      ctx.lineTo(hw, hh * 0.15)
      ctx.lineTo(0, hh * 0.65)
      ctx.lineTo(-hw, hh * 0.15)
      ctx.closePath()
    }
  }

  const strokePerfect = () => {
    const prx = r * perfectFactor
    const pry = prx * (0.42 / 0.95)
    ctx.beginPath()
    ctx.ellipse(0, 0, prx, pry, 0, 0, Math.PI * 2)
  }

  ctx.fillStyle = highlight ? 'rgba(56, 211, 159, 0.18)' : 'rgba(56, 211, 159, 0.09)'
  strokeLand()
  ctx.fill()
  ctx.strokeStyle = highlight ? 'rgba(56, 211, 159, 0.95)' : 'rgba(56, 211, 159, 0.55)'
  ctx.lineWidth = highlight ? 2 : 1.25
  ctx.setLineDash(highlight ? [] : [5, 4])
  strokeLand()
  ctx.stroke()

  ctx.fillStyle = highlight ? 'rgba(255, 107, 61, 0.24)' : 'rgba(255, 107, 61, 0.12)'
  ctx.setLineDash([])
  strokePerfect()
  ctx.fill()
  ctx.strokeStyle = highlight ? 'rgba(255, 107, 61, 0.95)' : 'rgba(255, 107, 61, 0.55)'
  ctx.lineWidth = highlight ? 2 : 1.25
  strokePerfect()
  ctx.stroke()

  const cross = Math.max(3, r * perfectFactor * 0.35)
  ctx.strokeStyle = highlight ? 'rgba(255, 107, 61, 0.9)' : 'rgba(255, 107, 61, 0.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(-cross, 0)
  ctx.lineTo(cross, 0)
  ctx.moveTo(0, -cross * 0.55)
  ctx.lineTo(0, cross * 0.55)
  ctx.stroke()
  ctx.restore()
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  originX: number,
  originY: number,
) {
  const { piece, camera } = state
  const p = worldToScreen(piece.x, piece.z, piece.y, camera.x, camera.z)
  const sx = originX + p.sx
  const sy = originY + p.sy
  const s = piece.squash
  const w = 16
  const h = 34 * s

  ctx.save()
  ctx.translate(sx, sy)
  // weapp-jump forerake / hypsokinesis tip when falling
  if (piece.tip !== 0) {
    ctx.rotate(piece.tip * 0.55)
  }

  ctx.fillStyle = 'rgba(0,0,0,0.18)'
  ctx.beginPath()
  ctx.ellipse(0, 6, 12 / Math.max(0.4, s), 5 / Math.max(0.4, s), 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#2b2f3a'
  ctx.beginPath()
  ctx.moveTo(-w * 0.35, 0)
  ctx.quadraticCurveTo(-w * 0.55, -h * 0.35, -w * 0.28, -h * 0.72)
  ctx.lineTo(w * 0.28, -h * 0.72)
  ctx.quadraticCurveTo(w * 0.55, -h * 0.35, w * 0.35, 0)
  ctx.closePath()
  ctx.fill()

  ctx.beginPath()
  ctx.ellipse(0, -h * 0.82, w * 0.32, w * 0.28, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#ff6b3d'
  ctx.beginPath()
  ctx.ellipse(0, -h * 0.95, w * 0.42, w * 0.16, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(-w * 0.16, -h * 1.18, w * 0.32, h * 0.22)
  ctx.beginPath()
  ctx.arc(0, -h * 1.2, w * 0.16, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#f5d0c0'
  ctx.beginPath()
  ctx.ellipse(piece.facing * 2, -h * 0.8, w * 0.18, w * 0.16, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

function drawChargeBar(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  originX: number,
  width: number,
) {
  if (state.status !== 'charging') return
  const barW = Math.min(180, width * 0.4)
  const barH = 8
  const x = originX - barW / 2
  const y = 28
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.fillRect(x, y, barW, barH)
  const grad = ctx.createLinearGradient(x, y, x + barW, y)
  grad.addColorStop(0, '#6ec6ff')
  grad.addColorStop(1, '#ff6b3d')
  ctx.fillStyle = grad
  ctx.fillRect(x, y, barW * state.charge, barH)
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
  ctx.strokeRect(x, y, barW, barH)
}

function drawPerfect(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  originX: number,
  originY: number,
) {
  const flash = state.perfectFlash
  if (!flash) return
  const platH = state.platforms[state.currentIndex]?.height ?? 1
  const p = worldToScreen(flash.x, flash.z, platH, state.camera.x, state.camera.z)
  const alpha = 1 - flash.age / 0.85
  ctx.save()
  ctx.globalAlpha = alpha
  // weapp-jump addWave rings on perfect
  const rings = Math.max(1, flash.ring)
  for (let i = 0; i < rings; i++) {
    const r = 10 + flash.age * 42 + i * 10
    ctx.strokeStyle = `rgba(255, 107, 61, ${0.55 - i * 0.1})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(originX + p.sx, originY + p.sy + 4, r, r * 0.45, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = '#ff6b3d'
  ctx.font = 'bold 22px "IBM Plex Sans", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(
    state.combo > 1 ? `完美 ×${state.double}` : '完美',
    originX + p.sx,
    originY + p.sy - 48,
  )
  ctx.restore()
}

function renderFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
  showHitBounds = true,
) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, '#f7efe3')
  gradient.addColorStop(0.55, '#efe4d4')
  gradient.addColorStop(1, '#d9cbb8')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = 'rgba(255,255,255,0.25)'
  ctx.beginPath()
  ctx.ellipse(width * 0.5, height * 0.72, width * 0.42, height * 0.12, 0, 0, Math.PI * 2)
  ctx.fill()

  const originX = width * 0.5
  const originY = height * 0.62

  const ordered = [...state.platforms].sort((a, b) => a.x + a.z - (b.x + b.z))
  const current = state.platforms[state.currentIndex]
  const next = state.platforms[state.currentIndex + 1]
  for (const plat of ordered) {
    const squash =
      state.status === 'charging' && current && plat.id === current.id
        ? 1 - state.charge * 0.18
        : 1
    drawPlatform(ctx, plat, state.camera.x, state.camera.z, originX, originY, squash)
    if (showHitBounds) {
      drawHitBounds(
        ctx,
        plat,
        state.camera.x,
        state.camera.z,
        originX,
        originY,
        squash,
        Boolean(next && plat.id === next.id),
      )
    }
  }

  drawPiece(ctx, state, originX, originY)
  drawPerfect(ctx, state, originX, originY)
  drawChargeBar(ctx, state, originX, width)

  if (showHitBounds) {
    ctx.save()
    ctx.font = '12px "IBM Plex Sans", sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(56, 211, 159, 0.95)'
    ctx.fillRect(14, height - 42, 10, 10)
    ctx.fillStyle = '#5a5248'
    ctx.fillText('落地：贴合台面（方台菱形 / 圆台椭圆）', 30, height - 33)
    ctx.fillStyle = 'rgba(255, 107, 61, 0.95)'
    ctx.fillRect(14, height - 24, 10, 10)
    ctx.fillStyle = '#5a5248'
    ctx.fillText(`完美：中心距离 ≤ ${PERFECT_HIT_DIST.toFixed(2)}（weapp √0.5）`, 30, height - 15)
    ctx.restore()
  }

  ctx.fillStyle = '#5a5248'
  ctx.font = 'bold 36px "IBM Plex Sans", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(String(state.score), width * 0.5, 48)

  if (
    state.status !== 'ready' &&
    state.status !== 'charging' &&
    state.status !== 'jumping' &&
    state.status !== 'falling'
  ) {
    ctx.fillStyle = 'rgba(40, 34, 28, 0.45)'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#fff8ef'
    ctx.font = 'bold 28px "IBM Plex Sans", sans-serif'
    ctx.textAlign = 'center'
    const title =
      state.status === 'idle' ? '跳一跳' : state.status === 'paused' ? '已暂停' : '游戏结束'
    ctx.fillText(title, width * 0.5, height * 0.42)
    ctx.font = '16px "IBM Plex Sans", sans-serif'
    ctx.fillStyle = 'rgba(255,248,239,0.9)'
    const tip =
      state.status === 'idle'
        ? '按住蓄力，松手跳跃'
        : state.status === 'paused'
          ? '空格继续'
          : `得分 ${state.score} · 跳跃 ${state.jumps}`
    ctx.fillText(tip, width * 0.5, height * 0.48)
  }
}

export function JumpExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [game, setGame] = useState<GameState>(() => createGame())
  const {
    mode,
    setMode,
    driverFeature,
    setDriverFeature,
    stress,
    setStress,
    features,
  } = useStressControl({ initial: 40 })
  const [showHitBounds, setShowHitBounds] = useState(true)
  const [notice, setNotice] = useState('按住屏幕/鼠标蓄力，松手跳跃。落在台面中心可连击加分。')

  const loggerRef = useRef(new SessionLogger('jump', subjectId))
  const signalRef = useRef(new ManualSignalSource({ kind: 'stress', initial: 40 }))
  const gameRef = useRef(game)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  const stressRef = useRef(stress)
  const showHitBoundsRef = useRef(showHitBounds)
  const rngRef = useRef(mulberry32(game.seed ^ 0x9e3779b9))
  const chargingPointerRef = useRef(false)

  const hudRef = useRef({
    status: game.status,
    score: game.score,
    combo: game.combo,
    double: game.double,
    jumps: game.jumps,
    bestCombo: game.bestCombo,
    charge: game.charge,
    holdMs: game.holdMs,
    elapsedS: game.elapsedS,
  })

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    stressRef.current = stress
    const sample = signalRef.current.push(stress)
    loggerRef.current.log('stress', { value: sample.value })
  }, [stress])

  useEffect(() => {
    showHitBoundsRef.current = showHitBounds
  }, [showHitBounds])

  const commitGame = useCallback((next: GameState) => {
    gameRef.current = next
    hudRef.current = {
      status: next.status,
      score: next.score,
      combo: next.combo,
      double: next.double,
      jumps: next.jumps,
      bestCombo: next.bestCombo,
      charge: next.charge,
      holdMs: next.holdMs,
      elapsedS: next.elapsedS,
    }
    setGame(next)
  }, [])

  const syncHud = useCallback((next: GameState) => {
    const prev = hudRef.current
    const hudChanged =
      next.status !== prev.status ||
      next.score !== prev.score ||
      next.combo !== prev.combo ||
      next.double !== prev.double ||
      next.jumps !== prev.jumps ||
      next.bestCombo !== prev.bestCombo ||
      Math.abs(next.charge - prev.charge) > 0.01 ||
      Math.abs(next.holdMs - prev.holdMs) > 30 ||
      Math.floor(next.elapsedS) !== Math.floor(prev.elapsedS)
    if (!hudChanged) return
    hudRef.current = {
      status: next.status,
      score: next.score,
      combo: next.combo,
      double: next.double,
      jumps: next.jumps,
      bestCombo: next.bestCombo,
      charge: next.charge,
      holdMs: next.holdMs,
      elapsedS: next.elapsedS,
    }
    setGame(next)
  }, [])

  const handleEvents = useCallback((events: JumpEvent[]) => {
    for (const event of events) {
      if ('data' in event) loggerRef.current.log(event.type, event.data)
      else loggerRef.current.log(event.type)
      if (event.type === 'jump') {
        setNotice(
          `起跳 · 蓄力 ${(event.data.power * 100).toFixed(0)}% · 距离 ${event.data.distance.toFixed(2)}`,
        )
      } else if (event.type === 'land') {
        setNotice(
          event.data.perfect
            ? `完美落地 · 倍率 ×${event.data.double} · +${event.data.scoreDelta}`
            : `落地 · +${event.data.scoreDelta}`,
        )
      } else if (event.type === 'miss' || event.type === 'gameover') {
        setNotice(`掉落了。得分 ${event.data.score}`)
      }
    }
  }, [])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    renderFrame(
      ctx,
      gameRef.current,
      canvas.width / dpr,
      canvas.height / dpr,
      showHitBoundsRef.current,
    )
  }, [])

  useEffect(() => {
    const frame = (timestamp: number) => {
      if (!lastFrameRef.current) lastFrameRef.current = timestamp
      const dtS = Math.min(0.05, (timestamp - lastFrameRef.current) / 1000)
      lastFrameRef.current = timestamp
      const status = gameRef.current.status
      if (
        status === 'charging' ||
        status === 'jumping' ||
        status === 'falling' ||
        status === 'ready'
      ) {
        const result = stepGame(gameRef.current, dtS, stressRef.current, rngRef.current)
        gameRef.current = result.state
        if (result.events.length) handleEvents(result.events)
        syncHud(result.state)
      }
      paint()
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafRef.current)
  }, [handleEvents, paint, syncHud])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return

    const resize = () => {
      const rect = stage.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(320, Math.floor(rect.width))
      const h = Math.max(420, Math.floor(rect.height))
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paint()
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [paint])

  const startGame = useCallback(() => {
    const seed = Date.now() >>> 0
    const next = createGame('ready', seed)
    rngRef.current = mulberry32(seed ^ 0x9e3779b9)
    loggerRef.current.clear()
    loggerRef.current.log('game_start', { seed, stress: stressRef.current })
    lastFrameRef.current = 0
    chargingPointerRef.current = false
    setNotice('按住蓄力，松手跳跃。中心落地可连击。')
    commitGame(next)
  }, [commitGame])

  const onPause = useCallback(() => {
    const result = togglePause(gameRef.current)
    if (!result.events.length) return
    handleEvents(result.events)
    lastFrameRef.current = 0
    commitGame(result.state)
  }, [commitGame, handleEvents])

  const tryBeginCharge = useCallback(() => {
    const current = gameRef.current
    if (current.status === 'idle' || current.status === 'gameover') {
      startGame()
      requestAnimationFrame(() => {
        const result = beginCharge(gameRef.current)
        if (result.events.length) {
          handleEvents(result.events)
          commitGame(result.state)
          chargingPointerRef.current = true
        }
      })
      return
    }
    const result = beginCharge(current)
    if (!result.events.length) return
    handleEvents(result.events)
    commitGame(result.state)
    chargingPointerRef.current = true
  }, [commitGame, handleEvents, startGame])

  const tryRelease = useCallback(() => {
    if (!chargingPointerRef.current && gameRef.current.status !== 'charging') return
    chargingPointerRef.current = false
    const result = releaseJump(gameRef.current, stressRef.current, rngRef.current)
    if (!result.events.length) return
    handleEvents(result.events)
    commitGame(result.state)
  }, [commitGame, handleEvents])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }
      // Difficulty / stress presets: 1=0 … 5=100 (manual mode only)
      if (event.key >= '1' && event.key <= '5') {
        if (mode === 'features') return
        event.preventDefault()
        const value = (Number(event.key) - 1) * 25
        setStress(value)
        setNotice(`压力档位 ${event.key} → ${value}`)
        return
      }
      if ((event.key === ' ' || event.key === 'p' || event.key === 'P') && !event.repeat) {
        event.preventDefault()
        if (event.key === 'p' || event.key === 'P') {
          onPause()
        } else if (gameRef.current.status === 'ready') {
          tryBeginCharge()
        } else if (gameRef.current.status === 'paused') {
          onPause()
        }
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault()
        tryRelease()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [onPause, tryBeginCharge, tryRelease, mode, setStress])

  const previewDist = jumpDistance(powerFromHold(Math.min(MAX_HOLD_MS, game.holdMs || 0)))

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回实验列表
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="m-0 text-2xl font-semibold">跳一跳</h1>
            <span className="chip">WeChat Jump</span>
          </div>
          <p className="muted mt-2 max-w-2xl text-sm">
            复刻微信「跳一跳」核心玩法（物理与计分对齐
            <a
              className="mx-1 underline"
              href="https://github.com/yaoshanliang/weapp-jump"
              target="_blank"
              rel="noreferrer"
            >
              weapp-jump
            </a>
           ）：按压蓄力、抛物线跳跃、完美连击倍率与难度递增。压力信号调节台距 / 台面大小。
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
          <div className="jump-hud">
            <div>
              <span>得分</span>
              <strong>{game.score}</strong>
            </div>
            <div>
              <span>连击倍率</span>
              <strong>×{game.double}</strong>
            </div>
            <div>
              <span>跳跃</span>
              <strong>{game.jumps}</strong>
            </div>
            <div>
              <span>蓄力</span>
              <strong>{(game.charge * 100).toFixed(0)}%</strong>
            </div>
            <div>
              <span>预估距离</span>
              <strong>{previewDist.toFixed(2)}</strong>
            </div>
            <div>
              <span>完美次数</span>
              <strong>{game.combo}</strong>
            </div>
          </div>

          <div
            ref={stageRef}
            className={`jump-stage status-${game.status}`}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              tryBeginCharge()
            }}
            onPointerUp={() => tryRelease()}
            onPointerCancel={() => tryRelease()}
          >
            <canvas ref={canvasRef} className="jump-canvas" />
          </div>

          <div className="rounded-xl border border-[#2a3550] bg-[#0d1425] px-4 py-3 text-sm">
            {notice}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={startGame}>
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
            <label className="chip cursor-pointer gap-1.5">
              <input
                type="checkbox"
                checked={showHitBounds}
                onChange={(e) => setShowHitBounds(e.target.checked)}
              />
              判定边界
            </label>
            <span className="chip">按住蓄力 · 松手跳跃 · 1–5 压力 · P 暂停</span>
          </div>
        </main>

        <aside className="space-y-4">
          <Panel
            title="压力信号"
            actions={
              <span className="chip" style={{ color: mode === 'features' ? 'var(--accent-2)' : 'var(--muted)' }}>
                {mode === 'features' ? '演示数据' : '手动'}
              </span>
            }
          >
            <SignalModeControls
              mode={mode}
              onModeChange={setMode}
              driverFeature={driverFeature}
              onDriverChange={setDriverFeature}
            />
            <Slider
              label={mode === 'features' ? '压力（演示输出，只读）' : '压力'}
              value={Math.round(stress)}
              min={0}
              max={100}
              onChange={setStress}
              disabled={mode === 'features'}
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
                    disabled={mode === 'features'}
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
              {mode === 'features'
                ? '演示数据调控中；点「手动输入」接管。'
                : '按键 / 点击 1–5 切档。压力越高：台距变大、台面变小。'}
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
              mode === 'features'
                ? `演示数据：${driverFeature} → 压力。点「手动输入」接管。`
                : '手动模式；可切「演示数据」让特征调控。'
            }
          />

          <Panel title="当前数值">
            <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-[#0f1628] p-2">
                <dt className="muted text-xs">台距系数</dt>
                <dd className="m-0 font-semibold">×{stressGapMult(stress).toFixed(2)}</dd>
              </div>
              <div className="rounded-lg bg-[#0f1628] p-2">
                <dt className="muted text-xs">台面系数</dt>
                <dd className="m-0 font-semibold">×{stressSizeMult(stress).toFixed(2)}</dd>
              </div>
              <div className="rounded-lg bg-[#0f1628] p-2">
                <dt className="muted text-xs">已运行</dt>
                <dd className="m-0 font-semibold">{game.elapsedS.toFixed(1)} s</dd>
              </div>
            </dl>
          </Panel>

          <Panel title="玩法">
            <ul className="muted m-0 space-y-2 pl-4 text-sm">
              <li>按住蓄力：时长决定 vz/vy（对齐 weapp-jump）</li>
              <li>松手后按重力抛物线飞行，落地判台</li>
              <li>普通落地 +1；完美连击倍率 2→4→6…≤32</li>
              <li>分数升高后面台更小、台距更大</li>
              <li>
                源码参考：
                <a
                  className="ml-1 underline"
                  href="https://github.com/yaoshanliang/weapp-jump"
                  target="_blank"
                  rel="noreferrer"
                >
                  yaoshanliang/weapp-jump
                </a>
              </li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
