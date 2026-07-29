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

function drawCell(
  ctx: CanvasRenderingContext2D,
  c: number,
  r: number,
  colorIndex: number,
  alpha = 1,
  cell = CELL,
) {
  ctx.globalAlpha = alpha
  const x = c * cell
  const y = r * cell
  ctx.fillStyle = COLORS[colorIndex] ?? '#888'
  ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'
  ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2)
  ctx.globalAlpha = 1
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
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r]!.length; c++) {
      if (!matrix[r]![c]) continue
      drawCell(ctx, ox + c, oy + r, colorIndex, alpha, cell)
    }
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
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
}

export function Board({ state }: { state: GameState }) {
  const ref = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = COLS * CELL
    const h = ROWS * CELL
    ctx.clearRect(0, 0, w, h)
    drawGrid(ctx, w, h)

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
            ctx.globalAlpha = flash
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2)
            ctx.globalAlpha = 1
            drawCell(ctx, c, r, v, 0.35 + 0.4 * flash)
          } else {
            drawCell(ctx, c, r, v)
          }
        }
      }
    } else if (anim?.kind === 'fall') {
      // Constant fall speed: shorter drops settle earlier; longer ones keep moving.
      const t = animProgress(anim)
      const fallen = t * Math.max(1, anim.maxDrop)
      for (const cell of anim.staticCells) {
        drawCell(ctx, cell.c, cell.fromR, cell.color)
      }
      for (const cell of anim.movers) {
        const drop = cell.toR - cell.fromR
        const local = drop <= 0 ? 1 : Math.min(1, fallen / drop)
        const eased = 1 - (1 - local) ** 3
        const y = cell.fromR + drop * eased
        drawCell(ctx, cell.c, y, cell.color)
      }
    } else {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = state.board[r]![c]!
          if (!v) continue
          drawCell(ctx, c, r, v)
        }
      }

      if (state.piece) {
        const gy = ghostY(state.board, state.piece)
        const color = colorOf(state.piece.type)
        const vy = visualY(state.piece)
        drawMatrix(ctx, state.piece.matrix, state.piece.x, gy, color, 0.22)
        drawMatrix(ctx, state.piece.matrix, state.piece.x, vy, color, 1)
      }
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
