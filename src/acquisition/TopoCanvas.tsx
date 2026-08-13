import { useEffect, useRef } from 'react'
import type { WaveformSnapshot } from './WaveformCanvas'
import { colorForValue, electrodeXy } from './montage/positions'

export interface TopoCanvasProps {
  getSnapshot: () => WaveformSnapshot
  channelNames: string[]
  visibleChannels: boolean[]
  windowSec: number
  sampleRate: number
  /** Metric: rms amplitude (μV) */
  metric?: 'rms' | 'absmean'
  height?: number
}

function channelMetric(
  buf: Float32Array,
  writeHead: number,
  filled: number,
  windowSamples: number,
  metric: 'rms' | 'absmean',
): number {
  const n = Math.min(filled, windowSamples)
  if (n < 4) return Number.NaN
  const bufLen = buf.length
  let sum = 0
  let sumSq = 0
  let dead = 0
  for (let i = 0; i < n; i++) {
    const idx = (((writeHead - n + i) % bufLen) + bufLen) % bufLen
    const v = buf[idx]!
    if (!Number.isFinite(v) || Math.abs(v) > 5e5) {
      dead += 1
      continue
    }
    sum += Math.abs(v)
    sumSq += v * v
  }
  const good = n - dead
  if (good < 4) return Number.NaN
  if (metric === 'absmean') return sum / good
  return Math.sqrt(sumSq / good)
}

export function TopoCanvas({
  getSnapshot,
  channelNames,
  visibleChannels,
  windowSec,
  sampleRate,
  metric = 'rms',
  height = 420,
}: TopoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapRef = useRef(getSnapshot)
  snapRef.current = getSnapshot
  const propsRef = useRef({
    channelNames,
    visibleChannels,
    windowSec,
    sampleRate,
    metric,
    height,
  })
  propsRef.current = { channelNames, visibleChannels, windowSec, sampleRate, metric, height }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const draw = () => {
      const ctx = canvas.getContext('2d')
      const p = propsRef.current
      if (!ctx) {
        raf = requestAnimationFrame(draw)
        return
      }
      const { buffers, writeHead, filled } = snapRef.current()
      const dpr = window.devicePixelRatio || 1
      const cssW = canvas.clientWidth
      const cssH = p.height
      const w = Math.max(1, Math.floor(cssW * dpr))
      const h = Math.max(1, Math.floor(cssH * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0c1220'
      ctx.fillRect(0, 0, cssW, cssH)

      const cx = cssW / 2
      const cy = cssH / 2 + 8
      const R = Math.min(cssW, cssH) * 0.38

      ctx.strokeStyle = '#2a3a55'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.stroke()
      // nose
      ctx.beginPath()
      ctx.moveTo(cx - 10, cy - R)
      ctx.lineTo(cx, cy - R - 18)
      ctx.lineTo(cx + 10, cy - R)
      ctx.stroke()
      // ears
      ctx.beginPath()
      ctx.arc(cx - R, cy, 10, Math.PI / 2, -Math.PI / 2, true)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cx + R, cy, 10, -Math.PI / 2, Math.PI / 2, true)
      ctx.stroke()

      const winN = Math.max(16, Math.floor(p.windowSec * p.sampleRate))
      const values: number[] = []
      const pts: Array<{ name: string; x: number; y: number; v: number; i: number }> = []
      for (let i = 0; i < p.channelNames.length; i++) {
        if (p.visibleChannels[i] === false || !buffers[i]) continue
        const name = p.channelNames[i]!
        const xy = electrodeXy(name)
        if (!xy) continue
        const v = channelMetric(buffers[i]!, writeHead, filled, winN, p.metric)
        if (Number.isFinite(v)) values.push(v)
        pts.push({ name, x: xy.x, y: xy.y, v, i })
      }

      let vmin = 0
      let vmax = 1
      if (values.length) {
        values.sort((a, b) => a - b)
        vmin = values[Math.floor(values.length * 0.1)]!
        vmax = values[Math.floor(values.length * 0.9)]! || vmin + 1
        if (vmax <= vmin) vmax = vmin + 1
      }

      ctx.fillStyle = '#9aa8c7'
      ctx.font = '12px IBM Plex Sans, sans-serif'
      ctx.fillText(
        `地形图 · ${p.metric.toUpperCase()} · 窗 ${p.windowSec.toFixed(1)}s`,
        12,
        18,
      )

      if (!pts.length) {
        ctx.fillText('无已知 10–20 电极名，无法绘制地形图', 12, 40)
        raf = requestAnimationFrame(draw)
        return
      }

      for (const pt of pts) {
        const px = cx + pt.x * R * 0.92
        const py = cy - pt.y * R * 0.92
        const t = Number.isFinite(pt.v) ? (pt.v - vmin) / (vmax - vmin) : 0
        const r = 14
        ctx.beginPath()
        ctx.fillStyle = Number.isFinite(pt.v) ? colorForValue(t) : '#334155'
        ctx.arc(px, py, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#0c1220'
        ctx.font = '10px IBM Plex Sans, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(pt.name, px, py + 3)
        ctx.textAlign = 'left'
      }

      // colorbar
      const barX = cssW - 28
      const barY = 40
      const barH = cssH - 70
      for (let i = 0; i < barH; i++) {
        const t = 1 - i / barH
        ctx.fillStyle = colorForValue(t)
        ctx.fillRect(barX, barY + i, 12, 1)
      }
      ctx.fillStyle = '#9aa8c7'
      ctx.font = '10px IBM Plex Sans, sans-serif'
      ctx.fillText(vmax.toFixed(0), barX - 36, barY + 8)
      ctx.fillText(vmin.toFixed(0), barX - 36, barY + barH)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block', borderRadius: 10 }}
      aria-label="EEG topography"
    />
  )
}
