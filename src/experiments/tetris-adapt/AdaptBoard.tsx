import { useEffect, useRef } from 'react'
import { BOARD_DEFAULT_CELL } from '../tetris/Board'
import { COLS, ROWS, ghostY, visualY, type GameState } from '../tetris/engine'
import {
  colorOf,
  drawCell,
  drawColumnBands,
  drawGrid,
  drawMatrix,
  drawOutlineCells,
} from '../tetris/wellDraw'
import { cellsOf, subjectLanding, type MiniState } from './miniBoard'
import { occupiedCells, type Task1State } from './task1Well'

function emptyBoard(cols: number, rows: number): number[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(0))
}

function drawLocked(
  ctx: CanvasRenderingContext2D,
  board: number[][],
  cell: number,
) {
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r]!.length; c++) {
      const v = board[r]![c]!
      if (!v) continue
      drawCell(ctx, c, r, v, cell)
    }
  }
}

/** Task 2 mini wells keep this cell size; they are a cropped 10-col grid, not a scaled-down toy. */
export function AdaptBoard({
  task1,
  mini,
  idleGame,
  overlay,
  flash,
  cell = BOARD_DEFAULT_CELL,
}: {
  task1?: Task1State | null
  mini?: MiniState | null
  idleGame?: GameState | null
  overlay?: string | null
  flash?: 'hit' | 'miss' | null
  cell?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cols = mini?.width ?? COLS
  const rows = mini?.height ?? ROWS
  const width = cols * cell
  const height = rows * cell

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
    drawGrid(ctx, cols, rows, cell)

    if (mini) {
      drawLocked(ctx, mini.board, cell)
      const color = colorOf(mini.subject.type)
      for (const pos of cellsOf(mini.subject)) {
        drawCell(ctx, pos.c, pos.r, color, cell, { glow: true, alpha: 0.95 })
      }
      drawOutlineCells(ctx, cellsOf(mini.teacher), cell, '#4ade80', true, 0.12)
      drawOutlineCells(ctx, cellsOf(subjectLanding(mini)), cell, '#f87171', false, 0.16)
      return
    }

    const game = task1?.game ?? idleGame ?? { board: emptyBoard(cols, rows), piece: null }
    drawLocked(ctx, game.board, cell)

    if (task1?.cue === 'left' || task1?.cue === 'right') {
      drawColumnBands(ctx, task1.highlightCols, rows, cell)
    }

    if (task1?.teacher && task1.cue === 'rotate') {
      drawOutlineCells(ctx, occupiedCells(task1.teacher), cell, '#4ade80', true, 0.14)
    }
    if (task1?.teacher && task1.cue === 'drop') {
      drawOutlineCells(ctx, occupiedCells(task1.teacher), cell, '#4ade80', true, 0.16)
    }
    if (task1?.teacher && (task1.cue === 'left' || task1.cue === 'right')) {
      drawOutlineCells(ctx, occupiedCells(task1.teacher), cell, '#e8b84a', true, 0.1)
    }

    if (game.piece) {
      const color = colorOf(game.piece.type)
      const gy = ghostY(game.board, game.piece)
      const vy = visualY(game.piece)
      drawMatrix(ctx, game.piece.matrix, game.piece.x, gy, color, cell, {
        alpha: 0.4,
        ghost: true,
      })
      drawMatrix(ctx, game.piece.matrix, game.piece.x, vy, color, cell, { glow: true })
    }
  }, [task1, mini, idleGame, cell, cols, rows, width, height])

  return (
    <div
      className={`ta-well ${flash === 'hit' ? 'ta-flash-hit' : flash === 'miss' ? 'ta-flash-miss' : ''}`}
      style={{ width }}
    >
      <div className="ta-well-frame" style={{ width, height }}>
        <canvas ref={canvasRef} className="block max-w-none" style={{ width, height }} />
        <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/5" />
        {overlay ? (
          <div className="ta-overlay">
            <p>{overlay}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
