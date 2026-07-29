/** Unified brain-signal abstraction. Swap ManualSignalSource for a real EEG bridge later. */

export type SignalKind = 'rating' | 'stress' | 'generic'

export interface SignalSample {
  /** Normalized value in the channel's natural range (e.g. -1..1 rating, 0..100 stress). */
  value: number
  /** High-resolution timestamp (performance.now or Date.now). */
  t: number
  kind: SignalKind
  meta?: Record<string, unknown>
}

export type SignalListener = (sample: SignalSample) => void

export interface SignalSource {
  readonly id: string
  readonly kind: SignalKind
  /** Most recent sample, or null if nothing received yet. */
  latest(): SignalSample | null
  subscribe(listener: SignalListener): () => void
  /** Optional lifecycle hooks for sources that need start/stop. */
  start?(): void
  stop?(): void
}
