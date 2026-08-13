/**
 * Omni live catch-up: ingest has priority over painting.
 * When estimated backlog exceeds 0.2 s, skip waveform/PSD redraw.
 */

export const LIVE_CATCHUP_THRESHOLD_S = 0.2
/** Omni serial drain budget per turn (seconds → ms). */
export const INGEST_DRAIN_BUDGET_MS = 6
/** Omni plot timer: 12.5 FPS, leaves time for draining. */
export const PLOT_INTERVAL_MS = 80

let queuedBytes = 0
let pendingSamples = 0
let queueDepth = 0
let sampleRate = 250
let bytesPerSecond = 48 * 250

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

export function liveLagSec(): number {
  return Math.max(
    queuedBytes / bytesPerSecond,
    queueDepth / sampleRate,
    pendingSamples / sampleRate,
  )
}

export function isCatchingUp(): boolean {
  return liveLagSec() > LIVE_CATCHUP_THRESHOLD_S
}

export function resetCatchup(): void {
  queuedBytes = 0
  pendingSamples = 0
  queueDepth = 0
}
