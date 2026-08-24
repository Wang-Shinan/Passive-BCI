import { COLORS, COLOR_INDEX, type PieceType } from './engine'

export type CellStyle = {
  alpha?: number
  glow?: boolean
  ghost?: boolean
}

export function colorOf(type: PieceType): number {
  return COLOR_INDEX[type]
}

/** Mix a hex color toward white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
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

export function roundRect(
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

export function drawCell(
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

  roundRect(ctx, x + size * 0.14, y + size * 0.1, size * 0.72, size * 0.24, radius * 0.6)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)'
  ctx.fill()

  roundRect(ctx, x, y, size, size, radius)
  ctx.lineWidth = Math.max(1, cell * 0.04)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.stroke()

  ctx.restore()
}

export function drawMatrix(
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

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  cols: number,
  rows: number,
  cell: number,
) {
  const w = cols * cell
  const h = rows * cell
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#0c1426')
  bg.addColorStop(1, '#080d1a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(91, 140, 255, 0.09)'
  ctx.lineWidth = 1
  for (let x = 1; x < cols; x++) {
    const px = Math.round(x * cell) + 0.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
  }
  for (let y = 1; y < rows; y++) {
    const py = Math.round(y * cell) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, py)
    ctx.lineTo(w, py)
    ctx.stroke()
  }
}

export function drawOverlay(
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

export function drawColumnBands(
  ctx: CanvasRenderingContext2D,
  cols: readonly number[],
  rows: number,
  cell: number,
  fill = 'rgba(232, 184, 74, 0.16)',
  stroke = 'rgba(232, 184, 74, 0.55)',
) {
  if (cols.length === 0) return
  ctx.save()
  for (const c of cols) {
    const x = c * cell
    ctx.fillStyle = fill
    ctx.fillRect(x, 0, cell, rows * cell)
    ctx.strokeStyle = stroke
    ctx.lineWidth = Math.max(1.5, cell * 0.08)
    ctx.strokeRect(x + 1, 1, cell - 2, rows * cell - 2)
  }
  ctx.restore()
}

export function drawOutlineCells(
  ctx: CanvasRenderingContext2D,
  cells: readonly { c: number; r: number }[],
  cell: number,
  color: string,
  dashed: boolean,
  fillAlpha: number,
) {
  const gap = Math.max(1, cell * 0.08)
  const radius = Math.max(2, cell * 0.18)
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, cell * 0.1)
  if (dashed) ctx.setLineDash([Math.max(3, cell * 0.22), Math.max(2, cell * 0.16)])
  for (const pos of cells) {
    if (pos.r < 0) continue
    const x = pos.c * cell + gap
    const y = pos.r * cell + gap
    const size = cell - gap * 2
    roundRect(ctx, x, y, size, size, radius)
    ctx.globalAlpha = fillAlpha
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = dashed ? 0.72 : 0.95
    ctx.stroke()
  }
  ctx.restore()
}
