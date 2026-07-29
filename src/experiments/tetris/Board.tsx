import { COLORS, COLS, ROWS, ghostY, previewMatrix, visualY, type GameState, type PieceType } from './engine'

const CELL = 28

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

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  matrix: number[][],
  ox: number,
  oy: number,
  colorIndex: number,
  alpha = 1,
  cell = CELL,
) {
  ctx.globalAlpha = alpha
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r]!.length; c++) {
      if (!matrix[r]![c]) continue
      const x = (ox + c) * cell
      const y = (oy + r) * cell
      ctx.fillStyle = COLORS[colorIndex] ?? '#888'
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2)
    }
  }
  ctx.globalAlpha = 1
}

export function Board({ state }: { state: GameState }) {
  const ref = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = COLS * CELL
    const h = ROWS * CELL
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0a1020'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = '#1a2438'
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath()
      ctx.moveTo(x * CELL, 0)
      ctx.lineTo(x * CELL, h)
      ctx.stroke()
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath()
      ctx.moveTo(0, y * CELL)
      ctx.lineTo(w, y * CELL)
      ctx.stroke()
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = state.board[r]![c]!
        if (!v) continue
        ctx.fillStyle = COLORS[v]!
        ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2)
      }
    }

    if (state.piece) {
      const gy = ghostY(state.board, state.piece)
      const color = colorOf(state.piece.type)
      const vy = visualY(state.piece)
      drawMatrix(ctx, state.piece.matrix, state.piece.x, gy, color, 0.22)
      drawMatrix(ctx, state.piece.matrix, state.piece.x, vy, color, 1)
    }

    if (state.gameOver) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#ff5d6c'
      ctx.font = 'bold 28px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('TOP OUT', w / 2, h / 2)
    } else if (state.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#e8eefc'
      ctx.font = 'bold 24px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('PAUSED', w / 2, h / 2)
    }
  }

  return (
    <canvas
      ref={ref}
      width={COLS * CELL}
      height={ROWS * CELL}
      className="rounded-xl border border-[var(--border)]"
    />
  )
}

export function NextPreview({ type }: { type: PieceType }) {
  const matrix = previewMatrix(type)
  const cell = 20
  const w = 4 * cell
  const h = 4 * cell
  const ref = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0a1020'
    ctx.fillRect(0, 0, w, h)
    const ox = Math.floor((4 - matrix[0]!.length) / 2)
    const oy = Math.floor((4 - matrix.length) / 2)
    drawMatrix(ctx, matrix, ox, oy, colorOf(type), 1, cell)
  }
  return <canvas ref={ref} width={w} height={h} className="rounded-lg border border-[var(--border)]" />
}
