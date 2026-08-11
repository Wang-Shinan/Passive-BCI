import { useEffect, useRef } from 'react'

const CHANNEL_COLORS = [
  '#5b8cff',
  '#38d39f',
  '#f5a524',
  '#ff5d6c',
  '#c084fc',
  '#22d3ee',
  '#fb7185',
  '#a3e635',
]

export interface WaveformSnapshot {
  buffers: Float32Array[]
  writeHead: number
  filled: number
}

export interface WaveformCanvasProps {
  getSnapshot: () => WaveformSnapshot
  channelNames: string[]
  visibleChannels: boolean[]
  /** Vertical scale in μV (peak) */
  yScaleUv: number
  /** Seconds of history to show */
  windowSec: number
  sampleRate: number
  height?: number
}

/**
 * Multi-channel scrolling EEG canvas. Uses peak-decimation for the visible
 * pixel width so 250 SPS × 8 ch stays smooth without Recharts overhead.
 */
export function WaveformCanvas({
  getSnapshot,
  channelNames,
  visibleChannels,
  yScaleUv,
  windowSec,
  sampleRate,
  height = 480,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const getSnapshotRef = useRef(getSnapshot)
  getSnapshotRef.current = getSnapshot

  const propsRef = useRef({
    channelNames,
    visibleChannels,
    yScaleUv,
    windowSec,
    sampleRate,
    height,
  })
  propsRef.current = {
    channelNames,
    visibleChannels,
    yScaleUv,
    windowSec,
    sampleRate,
    height,
  }

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

      const { buffers, writeHead, filled } = getSnapshotRef.current()
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

      const visibleIdx = p.channelNames
        .map((_, i) => i)
        .filter((i) => p.visibleChannels[i] !== false && buffers[i])
      const nVis = Math.max(1, visibleIdx.length)
      const rowH = cssH / nVis
      const windowSamples = Math.max(8, Math.floor(p.windowSec * p.sampleRate))
      const avail = Math.min(filled, windowSamples)
      const labelW = 52
      const plotW = Math.max(1, cssW - labelW - 8)

      ctx.strokeStyle = '#1a2438'
      ctx.lineWidth = 1
      for (let i = 0; i <= nVis; i++) {
        const y = i * rowH
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(cssW, y)
        ctx.stroke()
      }
      for (let g = 0; g <= 4; g++) {
        const x = labelW + (plotW * g) / 4
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, cssH)
        ctx.stroke()
      }

      if (avail < 2) {
        ctx.fillStyle = '#9aa8c7'
        ctx.font = '13px IBM Plex Sans, sans-serif'
        ctx.fillText('等待数据…', labelW + 12, cssH / 2)
        raf = requestAnimationFrame(draw)
        return
      }

      const bufLen = buffers[0]?.length ?? 0
      const pixels = Math.floor(plotW)

      visibleIdx.forEach((ch, row) => {
        const buf = buffers[ch]!
        const midY = row * rowH + rowH / 2
        const amp = Math.max(1, (rowH * 0.42) / Math.max(1e-6, p.yScaleUv))
        const color = CHANNEL_COLORS[ch % CHANNEL_COLORS.length]!

        ctx.fillStyle = color
        ctx.font = '12px IBM Plex Sans, sans-serif'
        ctx.fillText(p.channelNames[ch] ?? `CH${ch + 1}`, 8, midY + 4)

        ctx.strokeStyle = '#243049'
        ctx.beginPath()
        ctx.moveTo(labelW, midY)
        ctx.lineTo(cssW - 4, midY)
        ctx.stroke()

        ctx.strokeStyle = color
        ctx.lineWidth = 1.25
        ctx.beginPath()

        const samplesPerPixel = avail / pixels
        for (let px = 0; px < pixels; px++) {
          const i0 = Math.floor(px * samplesPerPixel)
          const i1 = Math.min(avail - 1, Math.floor((px + 1) * samplesPerPixel))
          let minV = Infinity
          let maxV = -Infinity
          for (let i = i0; i <= i1; i++) {
            const idx = (((writeHead - avail + i) % bufLen) + bufLen) % bufLen
            const v = buf[idx]!
            if (v < minV) minV = v
            if (v > maxV) maxV = v
          }
          const yMin = midY - Math.max(-p.yScaleUv, Math.min(p.yScaleUv, maxV)) * amp
          const yMax = midY - Math.max(-p.yScaleUv, Math.min(p.yScaleUv, minV)) * amp
          const x = labelW + px
          if (px === 0) ctx.moveTo(x, yMin)
          else ctx.lineTo(x, yMin)
          if (yMax !== yMin) ctx.lineTo(x, yMax)
        }
        ctx.stroke()
      })

      ctx.fillStyle = '#9aa8c7'
      ctx.font = '11px IBM Plex Sans, sans-serif'
      ctx.fillText(`±${p.yScaleUv} μV · ${p.windowSec.toFixed(1)}s`, labelW + 8, 14)

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block', borderRadius: 10 }}
      aria-label="EEG waveform"
    />
  )
}

export { CHANNEL_COLORS }
