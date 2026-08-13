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

const OMNI_COLORS = [
  '#7B61FF',
  '#2478FF',
  '#00A6D6',
  '#00A878',
  '#8EBB2A',
  '#E0A800',
  '#F47A22',
  '#E84545',
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
  /** Fill parent instead of a fixed pixel height. */
  fill?: boolean
  theme?: 'dark' | 'omni'
  showChannelLabels?: boolean
  onChannelClick?: (index: number) => void
  onChannelDblClick?: (index: number) => void
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
  fill = false,
  theme = 'dark',
  showChannelLabels = true,
  onChannelClick,
  onChannelDblClick,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const getSnapshotRef = useRef(getSnapshot)
  getSnapshotRef.current = getSnapshot
  const clickRef = useRef({ onChannelClick, onChannelDblClick })
  clickRef.current = { onChannelClick, onChannelDblClick }

  const propsRef = useRef({
    channelNames,
    visibleChannels,
    yScaleUv,
    windowSec,
    sampleRate,
    height,
    fill,
    theme,
    showChannelLabels,
  })
  propsRef.current = {
    channelNames,
    visibleChannels,
    yScaleUv,
    windowSec,
    sampleRate,
    height,
    fill,
    theme,
    showChannelLabels,
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
      const cssH = p.fill ? canvas.clientHeight || p.height : p.height
      const w = Math.max(1, Math.floor(cssW * dpr))
      const h = Math.max(1, Math.floor(cssH * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const omni = p.theme === 'omni'
      const pal = omni ? OMNI_COLORS : CHANNEL_COLORS
      ctx.fillStyle = omni ? '#ffffff' : '#0c1220'
      ctx.fillRect(0, 0, cssW, cssH)

      const visibleIdx = p.channelNames
        .map((_, i) => i)
        .filter((i) => p.visibleChannels[i] !== false && buffers[i])
      const nVis = Math.max(1, visibleIdx.length)
      const rowH = cssH / nVis
      const windowSamples = Math.max(8, Math.floor(p.windowSec * p.sampleRate))
      const avail = Math.min(filled, windowSamples)
      const labelW = p.showChannelLabels ? 52 : 8
      const plotW = Math.max(1, cssW - labelW - 8)

      ctx.strokeStyle = omni ? '#e2e6eb' : '#1a2438'
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
        ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
        ctx.font = '13px IBM Plex Sans, sans-serif'
        ctx.fillText('等待数据…', labelW + 12, cssH / 2)
        raf = requestAnimationFrame(draw)
        return
      }

      const bufLen = buffers[0]?.length ?? 0
      const pixels = Math.floor(plotW)

      visibleIdx.forEach((ch, row) => {
        const buf = buffers[ch]!
        const yTop = row * rowH
        const yBot = yTop + rowH
        const midY = yTop + rowH / 2
        // px / µV: ±yScaleUv fills ~84% of the row. Never floor this to 1 —
        // with 32 ch a 25 px row would otherwise draw ±100 px and flood the plot.
        const amp = (rowH * 0.42) / Math.max(1e-6, p.yScaleUv)
        const color = pal[ch % pal.length]!
        const clipY = (y: number) => Math.max(yTop + 0.5, Math.min(yBot - 0.5, y))

        if (p.showChannelLabels) {
          ctx.fillStyle = color
          ctx.font = '12px IBM Plex Sans, sans-serif'
          ctx.fillText(p.channelNames[ch] ?? `CH${ch + 1}`, 8, midY + 4)
        }

        ctx.strokeStyle = omni ? '#d8dde3' : '#243049'
        ctx.beginPath()
        ctx.moveTo(labelW, midY)
        ctx.lineTo(cssW - 4, midY)
        ctx.stroke()

        ctx.save()
        ctx.beginPath()
        ctx.rect(labelW, yTop, plotW, rowH)
        ctx.clip()

        ctx.strokeStyle = color
        ctx.lineWidth = 1.15
        ctx.beginPath()

        const samplesPerPixel = avail / pixels
        let started = false
        for (let px = 0; px < pixels; px++) {
          const i0 = Math.floor(px * samplesPerPixel)
          const i1 = Math.min(avail - 1, Math.floor((px + 1) * samplesPerPixel))
          let minV = Infinity
          let maxV = -Infinity
          for (let i = i0; i <= i1; i++) {
            const idx = (((writeHead - avail + i) % bufLen) + bufLen) % bufLen
            const v = buf[idx]!
            if (!Number.isFinite(v)) continue
            if (v < minV) minV = v
            if (v > maxV) maxV = v
          }
          if (minV === Infinity) continue
          const yHi = clipY(midY - Math.max(-p.yScaleUv, Math.min(p.yScaleUv, maxV)) * amp)
          const yLo = clipY(midY - Math.max(-p.yScaleUv, Math.min(p.yScaleUv, minV)) * amp)
          const x = labelW + px
          if (!started) {
            ctx.moveTo(x, yHi)
            started = true
          } else ctx.lineTo(x, yHi)
          if (yLo !== yHi) ctx.lineTo(x, yLo)
        }
        ctx.stroke()
        ctx.restore()
      })

      ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
      ctx.font = '11px IBM Plex Sans, sans-serif'
      ctx.fillText(`±${p.yScaleUv} μV · ${p.windowSec.toFixed(1)}s`, labelW + 8, 14)

      raf = requestAnimationFrame(draw)
    }

    const hitIndex = (clientY: number): number | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const p = propsRef.current
      const { buffers } = getSnapshotRef.current()
      const visibleIdx = p.channelNames
        .map((_, i) => i)
        .filter((i) => p.visibleChannels[i] !== false && buffers[i])
      if (!visibleIdx.length) return null
      const rect = canvas.getBoundingClientRect()
      const row = Math.floor(((clientY - rect.top) / rect.height) * visibleIdx.length)
      return visibleIdx[Math.max(0, Math.min(visibleIdx.length - 1, row))] ?? null
    }

    const onClick = (e: MouseEvent) => {
      const idx = hitIndex(e.clientY)
      if (idx != null) clickRef.current.onChannelClick?.(idx)
    }
    const onDbl = (e: MouseEvent) => {
      const idx = hitIndex(e.clientY)
      if (idx != null) clickRef.current.onChannelDblClick?.(idx)
    }
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('dblclick', onDbl)

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: fill ? '100%' : height,
        display: 'block',
        borderRadius: fill ? 0 : 10,
      }}
      aria-label="EEG waveform"
    />
  )
}

export { CHANNEL_COLORS }
