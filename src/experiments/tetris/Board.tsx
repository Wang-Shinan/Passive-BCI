import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COLORS,
  COLS,
  ROWS,
  animProgress,
  ghostY,
  previewMatrix,
  visualY,
  type GameState,
  type PieceType,
} from './engine'

export const BOARD_DEFAULT_CELL = 28
export const BOARD_MIN_CELL = 16
export const BOARD_MAX_CELL = 52

const CELL_KEY = 'passive-bci.tetris-cell'

export function clampBoardCell(value: number): number {
  return Math.min(BOARD_MAX_CELL, Math.max(BOARD_MIN_CELL, Math.round(value)))
}

function loadCell(): number {
  if (typeof localStorage === 'undefined') return BOARD_DEFAULT_CELL
  const raw = Number(localStorage.getItem(CELL_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampBoardCell(raw) : BOARD_DEFAULT_CELL
}

/** Board cell size in px, shared so column splitters can resize the board too. */
export function useBoardCell() {
  const [cell, setCell] = useState(loadCell)

  useEffect(() => {
    localStorage.setItem(CELL_KEY, String(cell))
  }, [cell])

  const update = useCallback((next: number | ((current: number) => number)) => {
    setCell((current) => clampBoardCell(typeof next === 'function' ? next(current) : next))
  }, [])

  return [cell, update] as const
}

function colorOf(type: PieceType): number {
  const map: Record<PieceType, number> = {
    I: 1,
    O: 2,
    T: 3,
    S: 4,
    Z: 5,
    J: 6,
    L: 7,
  }
  return map[type]
}

/** Mix a hex color toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : value
  const num = Number.parseInt(full, 16)
  if (!Number.isFinite(num)) return hex
  const target = amount >= 0 ? 255 : 0
  const t = Math.abs(amount)
  const mix = (channel: number) => Math.round(channel + (target - channel) * t)
  const r = mix((num >> 16) & 0xff)
  const g = mix((num >> 8) & 0xff)
  const b = mix(num & 0xff)
  return `rgb(${r}, ${g}, ${b})`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

type CellStyle = {
  alpha?: number
  glow?: boolean
  ghost?: boolean
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  c: number,
  r: number,
  colorIndex: number,
  cell: number,
  style: CellStyle = {},
) {
  const { alpha = 1, glow = false, ghost = false } = style
  const base = COLORS[colorIndex] ?? '#888'
  const gap = Math.max(1, cell * 0.06)
  const x = c * cell + gap
  const y = r * cell + gap
  const size = cell - gap * 2
  const radius = Math.max(2, cell * 0.18)

  ctx.save()
  ctx.globalAlpha = alpha

  if (ghost) {
    roundRect(ctx, x, y, size, size, radius)
    ctx.fillStyle = shade(base, -0.55)
    ctx.globalAlpha = alpha * 0.5
    ctx.fill()
    ctx.globalAlpha = alpha
    ctx.lineWidth = Math.max(1, cell * 0.07)
    ctx.strokeStyle = base
    ctx.stroke()
    ctx.restore()
    return
  }

  if (glow) {
    ctx.shadowColor = base
    ctx.shadowBlur = cell * 0.45
  }

  const gradient = ctx.createLinearGradient(x, y, x, y + size)
  gradient.addColorStop(0, shade(base, 0.32))
  gradient.addColorStop(0.55, base)
  gradient.addColorStop(1, shade(base, -0.3))

  roundRect(ctx, x, y, size, size, radius)
  ctx.fillStyle = gradient
  ctx.fill()
  ctx.shadowBlur = 0

  // Glossy top edge keeps blocks readable at small cell sizes.
  roundRect(ctx, x + size * 0.14, y + size * 0.1, size * 0.72, size * 0.24, radius * 0.6)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)'
  ctx.fill()

  roundRect(ctx, x, y, size, size, radius)
  ctx.lineWidth = Math.max(1, cell * 0.04)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.stroke()

  ctx.restore()
}

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  matrix: number[][],
  ox: number,
  oy: number,
  colorIndex: number,
  cell: number,
  style: CellStyle = {},
) {
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r]!.length; c++) {
      if (!matrix[r]![c]) continue
      drawCell(ctx, ox + c, oy + r, colorIndex, cell, style)
    }
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, cell: number) {
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#0c1426')
  bg.addColorStop(1, '#080d1a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(91, 140, 255, 0.09)'
  ctx.lineWidth = 1
  for (let x = 1; x < COLS; x++) {
    const px = Math.round(x * cell) + 0.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
  }
  for (let y = 1; y < ROWS; y++) {
    const py = Math.round(y * cell) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, py)
    ctx.lineTo(w, py)
    ctx.stroke()
  }
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cell: number,
  text: string,
  color: string,
  dim: number,
) {
  ctx.save()
  ctx.fillStyle = `rgba(4, 8, 18, ${dim})`
  ctx.fillRect(0, 0, w, h)
  ctx.font = `700 ${Math.max(16, cell)}px "IBM Plex Sans", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = color
  ctx.shadowBlur = cell * 0.6
  ctx.fillStyle = color
  ctx.fillText(text, w / 2, h / 2)
  ctx.restore()
}

export function Board({
  state,
  cell,
  onCellChange,
}: {
  state: GameState
  cell: number
  onCellChange: (next: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ x: number; y: number; cell: number } | null>(null)

  const width = COLS * cell
  const height = ROWS * cell

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(3, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    drawGrid(ctx, width, height, cell)

    const anim = state.anim

    if (anim?.kind === 'clear') {
      const t = animProgress(anim)
      const flash = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * 3))
      const cleared = new Set(anim.rows)

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = anim.board[r]![c]!
          if (!v) continue
          if (cleared.has(r)) {
            drawCell(ctx, c, r, v, cell, { alpha: 0.35 + 0.4 * flash, glow: true })
            ctx.save()
            ctx.globalAlpha = flash * 0.8
            roundRect(ctx, c * cell + 1, r * cell + 1, cell - 2, cell - 2, cell * 0.18)
            ctx.fillStyle = '#ffffff'
            ctx.fill()
            ctx.restore()
          } else {
            drawCell(ctx, c, r, v, cell)
          }
        }
      }
    } else if (anim?.kind === 'fall') {
      // Constant fall speed: shorter drops settle earlier; longer ones keep moving.
      const t = animProgress(anim)
      const fallen = t * Math.max(1, anim.maxDrop)
      for (const fc of anim.staticCells) {
        drawCell(ctx, fc.c, fc.fromR, fc.color, cell)
      }
      for (const fc of anim.movers) {
        const drop = fc.toR - fc.fromR
        const local = drop <= 0 ? 1 : Math.min(1, fallen / drop)
        const eased = 1 - (1 - local) ** 3
        drawCell(ctx, fc.c, fc.fromR + drop * eased, fc.color, cell)
      }
    } else {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = state.board[r]![c]!
          if (!v) continue
          drawCell(ctx, c, r, v, cell)
        }
      }

      if (state.piece) {
        const gy = ghostY(state.board, state.piece)
        const color = colorOf(state.piece.type)
        const vy = visualY(state.piece)
        drawMatrix(ctx, state.piece.matrix, state.piece.x, gy, color, cell, {
          alpha: 0.4,
          ghost: true,
        })
        drawMatrix(ctx, state.piece.matrix, state.piece.x, vy, color, cell, { glow: true })
      }
    }

    if (state.gameOver) {
      drawOverlay(ctx, width, height, cell, 'TOP OUT', '#ff5d6c', 0.62)
    } else if (state.paused) {
      drawOverlay(ctx, width, height, cell, 'PAUSED', '#e8eefc', 0.48)
    }
  }, [state, cell, width, height])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStart.current = { x: event.clientX, y: event.clientY, cell }
      setDragging(true)
    },
    [cell],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current
      if (!start) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      // Follow whichever axis the pointer moved most, keeping the 10:20 ratio.
      const next =
        Math.abs(dx) >= Math.abs(dy)
          ? (start.cell * COLS + dx) / COLS
          : (start.cell * ROWS + dy) / ROWS
      onCellChange(next)
    },
    [onCellChange],
  )

  const endDrag = useCallback(() => {
    if (!dragStart.current) return
    dragStart.current = null
    setDragging(false)
  }, [])

  return (
    <div className="relative w-fit select-none" style={{ width }}>
      <div
        className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[#080d1a] shadow-[0_18px_45px_rgba(0,0,0,0.45)]"
        style={{ width, height }}
      >
        <canvas ref={canvasRef} className="block max-w-none" style={{ width, height }} />
        <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/5" />
      </div>

      <div
        role="slider"
        aria-label="棋盘大小"
        aria-valuemin={BOARD_MIN_CELL}
        aria-valuemax={BOARD_MAX_CELL}
        aria-valuenow={cell}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onCellChange(BOARD_DEFAULT_CELL)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 4 : 1
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            onCellChange(cell + step)
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            onCellChange(cell - step)
          }
        }}
        title="拖动调整棋盘大小 · 双击还原"
        className={`absolute -bottom-1 -right-1 grid h-6 w-6 cursor-nwse-resize place-items-center rounded-md border border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] focus:outline-none focus-visible:border-[var(--accent)] ${
          dragging ? 'border-[var(--accent)] text-[var(--text)]' : ''
        }`}
      >
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true">
          <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.4" fill="none" />
        </svg>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-[#0b1020cc] px-2 py-1 font-mono text-xs text-[var(--text)]">
          {width} × {height} · {cell}px
        </div>
      )}
    </div>
  )
}

export function NextPreview({ type }: { type: PieceType }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cell = 20
  const size = 4 * cell

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)

    const bg = ctx.createLinearGradient(0, 0, 0, size)
    bg.addColorStop(0, '#0c1426')
    bg.addColorStop(1, '#080d1a')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, size, size)

    const matrix = previewMatrix(type)
    const ox = (4 - matrix[0]!.length) / 2
    const oy = (4 - matrix.length) / 2
    drawMatrix(ctx, matrix, ox, oy, colorOf(type), cell)
  }, [type, size])

  return (
    <canvas
      ref={canvasRef}
      className="block max-w-none rounded-lg border border-[var(--border)]"
      style={{ width: size, height: size }}
    />
  )
}
