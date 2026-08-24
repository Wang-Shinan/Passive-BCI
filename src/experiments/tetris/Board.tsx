import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COLS,
  ROWS,
  animProgress,
  ghostY,
  previewMatrix,
  visualY,
  type GameState,
  type PieceType,
} from './engine'
import {
  colorOf,
  drawCell,
  drawGrid,
  drawMatrix,
  drawOverlay,
  roundRect,
} from './wellDraw'

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
    drawGrid(ctx, COLS, ROWS, cell)

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
