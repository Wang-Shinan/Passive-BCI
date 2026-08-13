import { useEffect, useRef } from 'react'
import type { WaveformSnapshot } from './WaveformCanvas'
import { CHANNEL_COLORS } from './WaveformCanvas'
import { copyLatestChannel } from './analysis/impedance'
import { smoothPsdDb, welchPsd } from './analysis/welch'

export interface FftCanvasProps {
  getSnapshot: () => WaveformSnapshot
  channelNames: string[]
  visibleChannels: boolean[]
  windowSec: number
  sampleRate: number
  /** Max frequency axis (Hz) */
  fMaxHz?: number
  height?: number
  fill?: boolean
  theme?: 'dark' | 'omni'
}

export function FftCanvas({
  getSnapshot,
  channelNames,
  visibleChannels,
  windowSec,
  sampleRate,
  fMaxHz = 60,
  height = 420,
  fill = false,
  theme = 'dark',
}: FftCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapRef = useRef(getSnapshot)
  snapRef.current = getSnapshot
  const smoothRef = useRef<Map<number, { f: Float64Array; db: Float64Array }>>(new Map())
  const cacheRef = useRef<{ t: number; spectra: Array<{ ch: number; f: Float64Array; db: Float64Array }> }>({
    t: 0,
    spectra: [],
  })
  const propsRef = useRef({
    channelNames,
    visibleChannels,
    windowSec,
    sampleRate,
    fMaxHz,
    height,
    fill,
    theme,
  })
  propsRef.current = {
    channelNames,
    visibleChannels,
    windowSec,
    sampleRate,
    fMaxHz,
    height,
    fill,
    theme,
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
      const { buffers, writeHead, filled } = snapRef.current()
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
      ctx.fillStyle = omni ? '#ffffff' : '#0c1220'
      ctx.fillRect(0, 0, cssW, cssH)

      const padL = 52
      const padR = 12
      const padT = 28
      const padB = 32
      const plotW = Math.max(1, cssW - padL - padR)
      const plotH = Math.max(1, cssH - padT - padB)

      ctx.strokeStyle = omni ? '#e2e6eb' : '#1a2438'
      ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
      ctx.font = '11px IBM Plex Sans, sans-serif'
      const fMax = Math.min(p.fMaxHz, p.sampleRate / 2)
      const dbMin = -80
      const dbMax = 40
      for (let g = 0; g <= 4; g++) {
        const y = padT + (plotH * g) / 4
        ctx.beginPath()
        ctx.moveTo(padL, y)
        ctx.lineTo(cssW - padR, y)
        ctx.stroke()
        const db = dbMax - ((dbMax - dbMin) * g) / 4
        ctx.fillText(`${db.toFixed(0)}`, 8, y + 4)
      }
      for (let f = 0; f <= fMax; f += 10) {
        const x = padL + (f / fMax) * plotW
        ctx.beginPath()
        ctx.moveTo(x, padT)
        ctx.lineTo(x, padT + plotH)
        ctx.stroke()
        ctx.fillText(`${f}`, x - 6, cssH - 12)
      }
      ctx.fillText('Hz', cssW - padR - 18, cssH - 12)
      ctx.fillText('dB', 8, 16)
      const segSec = Math.min(4, Math.max(0.5, p.windowSec))
      ctx.fillText(`PSD Welch · ${segSec.toFixed(1)}s Hann · 75% overlap · 0–${fMax} Hz`, padL, 16)

      const visibleIdx = p.channelNames
        .map((_, i) => i)
        .filter((i) => p.visibleChannels[i] !== false && buffers[i])

      const now = performance.now()
      if (now - cacheRef.current.t > 1000 || !cacheRef.current.spectra.length) {
        const spectra: Array<{ ch: number; f: Float64Array; db: Float64Array }> = []
        const nperseg = Math.min(filled, Math.max(64, Math.floor(segSec * p.sampleRate)))
        for (const ch of visibleIdx) {
          const x = copyLatestChannel(
            buffers[ch]!,
            writeHead,
            filled,
            Math.max(nperseg, Math.floor(4 * p.sampleRate)),
          )
          const psd = welchPsd(x, p.sampleRate, { nperseg: Math.min(x.length, nperseg) })
          if (!psd) continue
          const smoothed = smoothPsdDb(psd.f, psd.p, smoothRef.current.get(ch) ?? null)
          smoothRef.current.set(ch, smoothed)
          spectra.push({ ch, f: smoothed.f, db: smoothed.db })
        }
        cacheRef.current = { t: now, spectra }
      }
      const spectra = cacheRef.current.spectra

      if (!spectra.length) {
        ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
        ctx.fillText('等待 ≥1 s 数据…', padL + 12, padT + plotH / 2)
        raf = requestAnimationFrame(draw)
        return
      }

      for (const sp of spectra) {
        const pal = omni
          ? ['#7B61FF', '#2478FF', '#00A6D6', '#00A878', '#8EBB2A', '#E0A800', '#F47A22', '#E84545']
          : CHANNEL_COLORS
        const color = pal[sp.ch % pal.length]!
        ctx.strokeStyle = color
        ctx.globalAlpha = Math.min(0.95, 0.35 + 0.5 / Math.sqrt(spectra.length))
        ctx.lineWidth = 1.25
        ctx.beginPath()
        let started = false
        for (let k = 1; k < sp.db.length; k++) {
          const f = sp.f[k]!
          if (f > fMax) break
          const x = padL + (f / fMax) * plotW
          const db = Math.min(dbMax, Math.max(dbMin, sp.db[k]!))
          const y = padT + plotH * (1 - (db - dbMin) / (dbMax - dbMin))
          if (!started) {
            ctx.moveTo(x, y)
            started = true
          } else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
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
      aria-label="EEG Welch PSD"
    />
  )
}
