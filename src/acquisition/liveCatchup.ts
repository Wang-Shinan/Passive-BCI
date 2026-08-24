/**
 * Omni live catch-up: ingest has priority over painting.
 *
 * Catch-up is only real JS backlog (queued samples / serial bytes).
 * Collect/Neuracle packet gaps and device-clock pipeline delay are
 * display metrics — they must not toggle catch-up, or the overlay
 * flickers every time a 100 ms TCP packet lands.
 */

import { sampleClock } from '../lib/eeg/sampleClock'

export const LIVE_CATCHUP_THRESHOLD_S = 0.35
export const LIVE_CATCHUP_CLEAR_S = 0.08
export const LIVE_LAG_WARN_MS = 80
export const LIVE_LAG_BAD_MS = 200
/** Omni serial drain budget per turn (seconds → ms). */
export const INGEST_DRAIN_BUDGET_MS = 8
/** Bridge bursts: spend more of the turn emptying the queue. */
export const BRIDGE_DRAIN_BUDGET_MS = 24
/** Fallback plot timer (FFT / low channel counts). */
export const PLOT_INTERVAL_MS = 80

/** Slow down painting when many traces would otherwise stall ingest. */
export function plotIntervalMs(visibleChannels: number): number {
  if (visibleChannels >= 48) return 120
  if (visibleChannels >= 24) return 90
  if (visibleChannels >= 12) return 70
  return 50
}

let queuedBytes = 0
let pendingSamples = 0
let queueDepth = 0
let sampleRate = 250
let bytesPerSecond = 48 * 250

let lastBatchAt = 0
let lastExpectedMs = 0
let lastExtraMs = 0
let jitterEwma = 0
let catchingUp = false

export function setCatchupClock(fs: number, frameBytes = 48): void {
  sampleRate = Math.max(1, fs)
  bytesPerSecond = Math.max(1, frameBytes * sampleRate)
}

export function addQueuedBytes(delta: number): void {
  queuedBytes = Math.max(0, queuedBytes + delta)
}

export function addPendingSamples(delta: number): void {
  pendingSamples = Math.max(0, pendingSamples + delta)
}

export function setFirmwareQueueDepth(depth: number): void {
  queueDepth = Math.max(0, depth)
}

/** Record a newly ingested batch so delay can be measured against cadence. */
export function noteLiveSamples(n: number, now = performance.now()): void {
  if (n <= 0) return
  const expectedMs = (n / sampleRate) * 1000
  if (lastBatchAt !== 0) {
    lastExtraMs = Math.max(0, now - lastBatchAt - lastExpectedMs)
    jitterEwma = jitterEwma === 0 ? lastExtraMs : jitterEwma * 0.8 + lastExtraMs * 0.2
  } else {
    lastExtraMs = 0
    jitterEwma = 0
  }
  lastExpectedMs = expectedMs
  lastBatchAt = now
}

export function liveLagSec(): number {
  return Math.max(
    queuedBytes / bytesPerSecond,
    queueDepth / sampleRate,
    pendingSamples / sampleRate,
  )
}

/**
 * Instantaneous delay: how long the next batch is overdue, or how late
 * the last batch was. Recovers to ~0 on the next on-time packet.
 */
export function liveClockLagMs(now = performance.now()): number {
  if (lastBatchAt === 0) return 0
  const overdue = Math.max(0, now - lastBatchAt - lastExpectedMs)
  return Math.max(overdue, lastExtraMs)
}

export function liveSinceBatchMs(now = performance.now()): number {
  if (lastBatchAt === 0) return 0
  return Math.max(0, now - lastBatchAt)
}

export function liveJitterMs(): number {
  return jitterEwma
}

export function isCatchingUp(): boolean {
  const backlog = liveLagSec()
  if (catchingUp) catchingUp = backlog > LIVE_CATCHUP_CLEAR_S
  else catchingUp = backlog > LIVE_CATCHUP_THRESHOLD_S
  return catchingUp
}

export function lagWarnLevel(clockMs: number, backlogSec: number): 0 | 1 | 2 {
  const ms = Math.max(clockMs, backlogSec * 1000)
  if (ms >= LIVE_LAG_BAD_MS) return 2
  if (ms >= LIVE_LAG_WARN_MS) return 1
  return 0
}

export function formatLagMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function resetCatchup(): void {
  queuedBytes = 0
  pendingSamples = 0
  queueDepth = 0
  lastBatchAt = 0
  lastExpectedMs = 0
  lastExtraMs = 0
  jitterEwma = 0
  catchingUp = false
  sampleClock.reset()
}
