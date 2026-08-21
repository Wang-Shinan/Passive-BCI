import { useEffect, useRef } from 'react'
import {
  formatLagMs,
  isCatchingUp,
  liveClockLagMs,
  liveLagSec,
  plotIntervalMs,
} from './liveCatchup'
import { CHANNEL_COLORS, OMNI_COLORS } from './waveformPalette'

const MIN_ROW_PX = 32
const PX_PER_CM = 96 / 2.54
const TIME_AXIS_PX = 18
const SWEEP_GAP_PX = 14

function sampleDelta(writeHead: number, lastWriteHead: number, bufLen: number): number {
  if (lastWriteHead < 0 || bufLen <= 0) return 0
  return (((writeHead - lastWriteHead) % bufLen) + bufLen) % bufLen
}

export interface WaveformSnapshot {
  buffers: Float32Array[]
  writeHead: number
  filled: number
}

export interface WaveformCanvasProps {
  getSnapshot: () => WaveformSnapshot
  channelNames: string[]
  visibleChannels: boolean[]
  yScaleUv: number
  windowSec: number
  sampleRate: number
  height?: number
  fill?: boolean
  theme?: 'dark' | 'omni'
  /** Collect-style left-to-right overwrite vs paper-tape scroll. */
  scan?: 'scroll' | 'sweep'
  showChannelLabels?: boolean
  onChannelClick?: (index: number) => void
  onChannelDblClick?: (index: number) => void
}

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
  scan = 'scroll',
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
    scan,
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
    scan,
    showChannelLabels,
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    const traces = document.createElement('canvas')
    const scratch = document.createElement('canvas')
    const tctx = traces.getContext('2d', { alpha: false })
    const sctx = scratch.getContext('2d', { alpha: false })
    let layoutKey = ''
    let lastWriteHead = -1
    let lastAvail = 0
    let lastShownAvail = 0
    let lastBuf0: Float32Array | null = null
    let scrolling = false
    let behind = 0
    let lastTick = 0
    let pxAcc = 0
    let pagePos = 0
    let lastCol = 0
    let stats = { full: 0, blit: 0, grow: 0, skip: 0, ms: 0, n: 0, maxMs: 0, arr: 0 }
    let lastBeacon = 0

    const beacon = (extra: string) => {
      const now = performance.now()
      if (now - lastBeacon < 4000) return
      lastBeacon = now
      const avg = stats.n ? stats.ms / stats.n : 0
      const line =
        `${extra} full=${stats.full} blit=${stats.blit} grow=${stats.grow} skip=${stats.skip}` +
        ` avg=${avg.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms behind=${Math.round(behind)} arr=${stats.arr}`
      stats = { full: 0, blit: 0, grow: 0, skip: 0, ms: 0, n: 0, maxMs: 0, arr: 0 }
      if (typeof console !== 'undefined' && console.debug) console.debug('[paint]', line)
    }

    const paint = (frameT: number) => {
      if (!ctx || !tctx || !sctx) return
      const t0 = performance.now()
      const p = propsRef.current
      const sweep = p.scan === 'sweep'
      const visibleIdx: number[] = []
      for (let i = 0; i < p.channelNames.length; i++) {
        if (p.visibleChannels[i] !== false) visibleIdx.push(i)
      }
      const nVis = Math.max(1, visibleIdx.length)
      const { buffers, writeHead, filled } = getSnapshotRef.current()
      const cssW = Math.max(1, canvas.clientWidth | 0)
      const cssH = Math.max(nVis * MIN_ROW_PX, p.height)
      if (canvas.style.height !== `${cssH}px`) canvas.style.height = `${cssH}px`
      if (Math.abs(canvas.width - cssW) > 24 || canvas.height !== cssH) {
        canvas.width = cssW
        canvas.height = cssH
        layoutKey = ''
      }

      const omni = p.theme === 'omni'
      const pal = omni ? OMNI_COLORS : CHANNEL_COLORS
      const bg = omni ? '#ffffff' : '#0c1220'
      const grid = omni ? '#e2e6eb' : '#1a2438'
      const midLine = omni ? '#d8dde3' : '#243049'
      const rowH = (cssH - TIME_AXIS_PX) / nVis
      const bufLen = buffers[0]?.length ?? 0
      const windowSamples = Math.max(8, Math.floor(p.windowSec * p.sampleRate))
      const displaySamples = Math.min(windowSamples, Math.max(8, bufLen))
      const spanSec = displaySamples / Math.max(1, p.sampleRate)
      const avail = Math.min(filled, displaySamples)
      const labelW = p.showChannelLabels ? 52 : 8
      const plotW = Math.max(1, cssW - labelW - 8)
      const key = `${cssW}x${cssH}:${nVis}:${p.yScaleUv}:${p.windowSec}:${p.sampleRate}:${labelW}:${visibleIdx.length}:${p.scan}`

      const tw = plotW
      const th = Math.max(1, cssH - TIME_AXIS_PX)
      if (traces.width !== tw || traces.height !== th) {
        traces.width = tw
        traces.height = th
        scratch.width = tw
        scratch.height = th
        layoutKey = ''
      }

      const layoutReset = key !== layoutKey
      const bufReset = buffers[0] !== lastBuf0 || avail < lastAvail
      const arrived = lastWriteHead < 0 || bufReset ? 0 : sampleDelta(writeHead, lastWriteHead, bufLen)
      if (!bufReset) behind += arrived
      else {
        behind = 0
        lastShownAvail = 0
        scrolling = false
        pxAcc = 0
        pagePos = 0
        lastCol = 0
      }
      stats.arr += arrived

      const dt = lastTick === 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (frameT - lastTick) / 1000))
      lastTick = frameT
      const floor = Math.max(1, Math.round(0.1 * p.sampleRate))
      let pace = 1
      if (behind > floor * 3) pace = 1.08
      if (behind > floor * 6) pace = 1.2
      const natural = dt * p.sampleRate
      const extra = behind - floor
      const step = extra > 0 && natural > 0 ? Math.min(extra, natural * pace) : 0
      behind -= step

      if (!layoutReset && !bufReset && step < 1e-6 && arrived === 0 && avail === lastAvail) {
        stats.skip += 1
        lastWriteHead = writeHead
        lastAvail = avail
        beacon(`${nVis}ch`)
        return
      }

      const cols = plotW
      const samplesPerCol = displaySamples / cols
      const full = avail >= displaySamples
      const shownHead = (((writeHead - Math.round(behind)) % bufLen) + bufLen) % bufLen
      const shownAvail = Math.max(0, avail - Math.round(behind))
      const reset = layoutReset || bufReset
      const amp = PX_PER_CM / Math.max(1e-6, p.yScaleUv)

      const drawCols = (col0: number, col1: number, head: number, span: number) => {
        const origin = (((head - span) % bufLen) + bufLen) % bufLen
        tctx.save()
        tctx.beginPath()
        tctx.rect(0, 0, tw, th)
        tctx.clip()
        for (let row = 0; row < visibleIdx.length; row++) {
          const ch = visibleIdx[row]!
          const buf = buffers[ch]
          if (!buf) continue
          const midY = row * rowH + rowH / 2
          tctx.fillStyle = pal[ch % pal.length]!
          for (let col = col0; col < col1; col++) {
            const i0 = (col * samplesPerCol) | 0
            if (i0 >= span) break
            const i1 = Math.min(span - 1, ((col + 1) * samplesPerCol) | 0)
            let minV = Infinity
            let maxV = -Infinity
            for (let i = i0; i <= i1; i++) {
              const v = buf[(origin + i) % bufLen]!
              if (v < minV) minV = v
              if (v > maxV) maxV = v
            }
            if (minV === Infinity) continue
            const yHi = midY - maxV * amp
            tctx.fillRect(col, yHi, 1, Math.max(1, midY - minV * amp - yHi))
          }
        }
        tctx.restore()
      }

      const drawSweepSpan = (col0: number, col1: number, head: number, nSamples: number) => {
        const n = Math.max(1, Math.round(nSamples))
        if (col1 <= col0 || n < 1) return
        const origin = (((head - n) % bufLen) + bufLen) % bufLen
        const width = col1 - col0
        tctx.save()
        tctx.beginPath()
        tctx.rect(0, 0, tw, th)
        tctx.clip()
        tctx.fillStyle = bg
        tctx.fillRect(col0, 0, width, th)
        for (let row = 0; row < visibleIdx.length; row++) {
          const ch = visibleIdx[row]!
          const buf = buffers[ch]
          if (!buf) continue
          const midY = row * rowH + rowH / 2
          tctx.fillStyle = pal[ch % pal.length]!
          for (let col = col0; col < col1; col++) {
            const i0 = Math.max(0, (((col - col0) / width) * n) | 0)
            const i1 = Math.min(n - 1, Math.max(i0, ((((col + 1 - col0) / width) * n) | 0) - 1))
            let minV = Infinity
            let maxV = -Infinity
            for (let i = i0; i <= i1; i++) {
              const v = buf[(origin + i) % bufLen]!
              if (v < minV) minV = v
              if (v > maxV) maxV = v
            }
            if (minV === Infinity) continue
            const yHi = midY - maxV * amp
            tctx.fillRect(col, yHi, 1, Math.max(1, midY - minV * amp - yHi))
          }
        }
        tctx.restore()
      }

      const eraseGap = (fromCol: number) => {
        const g0 = (fromCol + 1) % cols
        tctx.fillStyle = bg
        if (g0 + SWEEP_GAP_PX <= cols) {
          tctx.fillRect(g0, 0, SWEEP_GAP_PX, th)
        } else {
          tctx.fillRect(g0, 0, cols - g0, th)
          tctx.fillRect(0, 0, SWEEP_GAP_PX - (cols - g0), th)
        }
      }

      let mode: 'full' | 'blit' | 'grow' | 'skip' | 'sweep' = 'skip'
      let penCol = lastCol
      if (avail >= 2) {
        if (sweep) {
          if (reset) {
            tctx.setTransform(1, 0, 0, 1, 0, 0)
            tctx.fillStyle = bg
            tctx.fillRect(0, 0, tw, th)
            pagePos = 0
            lastCol = 0
            mode = 'full'
          }
          if (step > 0) {
            const prev = pagePos
            pagePos += step
            let wrapped = false
            if (pagePos >= displaySamples) {
              wrapped = true
              pagePos -= displaySamples
              if (pagePos >= displaySamples) pagePos %= displaySamples
            }
            const col = Math.min(cols - 1, ((pagePos / displaySamples) * cols) | 0)
            const prevCol = Math.min(cols - 1, ((prev / displaySamples) * cols) | 0)
            if (wrapped || col < prevCol) {
              const a = Math.max(1, cols - prevCol)
              const b = Math.max(1, col + 1)
              const samplesA = step * (a / (a + b))
              const samplesB = step - samplesA
              drawSweepSpan(prevCol, cols, (((shownHead - Math.round(samplesB)) % bufLen) + bufLen) % bufLen, samplesA)
              drawSweepSpan(0, col + 1, shownHead, samplesB)
              mode = 'sweep'
            } else {
              drawSweepSpan(prevCol, col + 1, shownHead, step)
              mode = 'sweep'
            }
            eraseGap(col)
            lastCol = col
            penCol = col
          } else if (reset) {
            mode = 'full'
            penCol = lastCol
          }
        } else if (reset || (full && !scrolling)) {
          tctx.setTransform(1, 0, 0, 1, 0, 0)
          tctx.fillStyle = bg
          tctx.fillRect(0, 0, tw, th)
          pxAcc = 0
          if (full) {
            drawCols(0, cols, shownHead, displaySamples)
            scrolling = true
          } else {
            drawCols(
              0,
              Math.min(cols, Math.ceil(shownAvail / samplesPerCol) + 1),
              shownHead,
              shownAvail,
            )
            scrolling = false
          }
          mode = 'full'
        } else if (!full) {
          const visAvail = Math.max(shownAvail, lastShownAvail)
          const col0 = Math.max(0, (lastShownAvail / samplesPerCol) | 0)
          const col1 = Math.min(cols, Math.ceil(visAvail / samplesPerCol) + 1)
          if (col1 > col0) {
            drawCols(col0, col1, shownHead, visAvail)
            mode = 'grow'
          }
        } else {
          pxAcc += (step / displaySamples) * plotW
          const dx = Math.floor(pxAcc + 1e-6)
          pxAcc -= dx
          if (dx >= tw) {
            tctx.fillStyle = bg
            tctx.fillRect(0, 0, tw, th)
            drawCols(0, cols, shownHead, displaySamples)
            mode = 'full'
          } else if (dx >= 1) {
            sctx.drawImage(traces, dx, 0, tw - dx, th, 0, 0, tw - dx, th)
            tctx.drawImage(scratch, 0, 0)
            tctx.fillStyle = bg
            tctx.fillRect(tw - dx, 0, dx, th)
            drawCols(Math.max(0, cols - dx - 1), cols, shownHead, displaySamples)
            mode = 'blit'
          }
          scrolling = true
        }
      }

      if (mode === 'skip') {
        stats.skip += 1
        lastWriteHead = writeHead
        lastAvail = avail
        lastBuf0 = buffers[0] ?? null
        layoutKey = key
        beacon(`${nVis}ch`)
        return
      }

      if (mode === 'full' || reset || layoutKey === '') {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.fillStyle = bg
        ctx.fillRect(0, 0, cssW, cssH)
        ctx.strokeStyle = grid
        ctx.lineWidth = 1
        for (let i = 0; i <= nVis; i++) {
          const y = i * rowH
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(cssW, y)
          ctx.stroke()
        }
        const tick = spanSec > 8 ? 1 : spanSec > 3 ? 0.5 : 0.2
        for (let ts = 0; ts <= spanSec + 1e-6; ts += tick) {
          const x = labelW + (ts / Math.max(1e-6, spanSec)) * plotW
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, th)
          ctx.stroke()
        }
        for (let row = 0; row < visibleIdx.length; row++) {
          const ch = visibleIdx[row]!
          const midY = row * rowH + rowH / 2
          ctx.strokeStyle = midLine
          ctx.beginPath()
          ctx.moveTo(labelW, midY)
          ctx.lineTo(cssW - 4, midY)
          ctx.stroke()
          if (p.showChannelLabels) {
            ctx.fillStyle = pal[ch % pal.length]!
            ctx.font = '12px IBM Plex Sans, sans-serif'
            ctx.fillText(p.channelNames[ch] ?? `CH${ch + 1}`, 8, midY + 4)
          }
        }
      }

      if (avail < 2) {
        ctx.fillStyle = bg
        ctx.fillRect(labelW, 0, plotW, th)
        ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
        ctx.font = '13px IBM Plex Sans, sans-serif'
        ctx.fillText('等待数据…', labelW + 12, th / 2)
      } else {
        ctx.drawImage(traces, 0, 0, tw, th, labelW, 0, plotW, th)
        const nowX = sweep
          ? labelW + penCol
          : !full
            ? labelW + (shownAvail / displaySamples) * plotW
            : -1
        if (nowX >= 0) {
          ctx.strokeStyle = omni ? '#2478FF' : '#5b8cff'
          ctx.globalAlpha = 0.7
          ctx.beginPath()
          ctx.moveTo(nowX, 0)
          ctx.lineTo(nowX, th)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }

      const ms = performance.now() - t0
      stats[mode === 'sweep' ? 'blit' : mode] += 1
      stats.ms += ms
      stats.n += 1
      if (ms > stats.maxMs) stats.maxMs = ms

      ctx.fillStyle = bg
      ctx.fillRect(0, th, cssW, TIME_AXIS_PX)
      ctx.strokeStyle = grid
      ctx.beginPath()
      ctx.moveTo(0, th)
      ctx.lineTo(cssW, th)
      ctx.stroke()
      const tick = spanSec > 8 ? 1 : spanSec > 3 ? 0.5 : 0.2
      ctx.font = '10px IBM Plex Sans, sans-serif'
      for (let ts = 0; ts <= spanSec + 1e-6; ts += tick) {
        const x = labelW + (ts / Math.max(1e-6, spanSec)) * plotW
        ctx.strokeStyle = grid
        ctx.beginPath()
        ctx.moveTo(x, th)
        ctx.lineTo(x, cssH)
        ctx.stroke()
        const text = sweep
          ? `${Number.isInteger(ts) || Math.abs(ts - Math.round(ts)) < 0.05 ? Math.round(ts) : ts.toFixed(1)}s`
          : ts < 0.05
            ? `-${spanSec % 1 && Math.abs(spanSec - Math.round(spanSec)) > 0.05 ? spanSec.toFixed(1) : Math.round(spanSec)}s`
            : Math.abs(ts - spanSec) < 0.05
              ? '0'
              : `-${(spanSec - ts).toFixed(Math.abs((spanSec - ts) % 1) < 0.05 ? 0 : 1)}s`
        ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
        ctx.fillText(text, Math.min(x + 2, cssW - 28), cssH - 5)
      }

      ctx.fillStyle = bg
      ctx.fillRect(labelW + 8, 2, 480, 16)
      ctx.fillStyle = omni ? '#5d6870' : '#9aa8c7'
      ctx.font = '11px IBM Plex Sans, sans-serif'
      ctx.fillText(
        `${p.yScaleUv} μV/cm · ${spanSec.toFixed(1)}s · ${sweep ? '扫描' : mode} ${ms.toFixed(1)}ms · ${nVis}ch`,
        labelW + 8,
        14,
      )
      if (isCatchingUp()) {
        ctx.fillStyle = omni ? '#fff4ed' : '#1a2438'
        ctx.fillRect(8, 4, 300, 18)
        ctx.fillStyle = omni ? '#b83c00' : '#f5a524'
        ctx.fillText(
          `追帧中：延迟 ${formatLagMs(liveClockLagMs())} / 积压 ${liveLagSec().toFixed(2)} s`,
          16,
          17,
        )
      }

      layoutKey = key
      lastWriteHead = writeHead
      lastAvail = avail
      lastShownAvail = full ? shownAvail : Math.max(lastShownAvail, shownAvail)
      lastBuf0 = buffers[0] ?? null
      beacon(`${nVis}ch ${sweep ? 'sweep' : mode}`)
    }

    const hitIndex = (clientY: number): number | null => {
      const node = canvasRef.current
      if (!node) return null
      const p = propsRef.current
      const { buffers } = getSnapshotRef.current()
      const visibleIdx = p.channelNames
        .map((_, i) => i)
        .filter((i) => p.visibleChannels[i] !== false && buffers[i])
      if (!visibleIdx.length) return null
      const rect = node.getBoundingClientRect()
      const y = clientY - rect.top
      const plotH = Math.max(1, rect.height - TIME_AXIS_PX)
      if (y < 0 || y >= plotH) return null
      const row = Math.floor((y / plotH) * visibleIdx.length)
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
    let timer = 0
    const loop = () => {
      const p = propsRef.current
      let nVis = 0
      for (let i = 0; i < p.channelNames.length; i++) {
        if (p.visibleChannels[i] !== false) nVis += 1
      }
      paint(performance.now())
      timer = window.setTimeout(loop, plotIntervalMs(nVis))
    }
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('dblclick', onDbl)
    timer = window.setTimeout(loop, 0)
    return () => {
      window.clearTimeout(timer)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        display: 'block',
        borderRadius: fill ? 0 : 10,
      }}
      aria-label="EEG waveform"
    />
  )
}
