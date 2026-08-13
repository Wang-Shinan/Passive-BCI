/** Schulte grid: find numbers 1..n² in order; record per-click RT. */

import { mulberry32 } from '../../lib/rng'

export type GridSize = 3 | 4 | 5 | 6

export interface SchulteCell {
  value: number
  row: number
  col: number
}

export interface ClickRecord {
  target: number
  rtMs: number
  /** Cumulative time from trial start */
  cumMs: number
  correct: boolean
  /** Wrong cell value if incorrect */
  clicked?: number
  tAbs: number
}

export interface SchulteTrialState {
  size: GridSize
  cells: SchulteCell[]
  nextTarget: number
  status: 'idle' | 'running' | 'done'
  startedAt: number | null
  lastClickAt: number | null
  clicks: ClickRecord[]
  errors: number
  seed: number
}

export function totalCells(size: GridSize): number {
  return size * size
}

export function createSchulteTrial(size: GridSize, seed?: number): SchulteTrialState {
  const s = seed ?? ((Math.random() * 0xffffffff) >>> 0)
  const rng = mulberry32(s)
  const n = totalCells(size)
  const values = Array.from({ length: n }, (_, i) => i + 1)
  // Fisher–Yates
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[values[i], values[j]] = [values[j]!, values[i]!]
  }
  const cells: SchulteCell[] = values.map((value, idx) => ({
    value,
    row: Math.floor(idx / size),
    col: idx % size,
  }))
  return {
    size,
    cells,
    nextTarget: 1,
    status: 'idle',
    startedAt: null,
    lastClickAt: null,
    clicks: [],
    errors: 0,
    seed: s,
  }
}

export function startTrial(state: SchulteTrialState, now = performance.now()): SchulteTrialState {
  return {
    ...state,
    status: 'running',
    startedAt: now,
    lastClickAt: now,
    nextTarget: 1,
    clicks: [],
    errors: 0,
  }
}

export function clickCell(
  state: SchulteTrialState,
  value: number,
  now = performance.now(),
): { state: SchulteTrialState; record: ClickRecord | null } {
  if (state.status !== 'running' || state.startedAt == null || state.lastClickAt == null) {
    return { state, record: null }
  }

  const rtMs = Math.max(0, now - state.lastClickAt)
  const cumMs = Math.max(0, now - state.startedAt)
  const correct = value === state.nextTarget

  const record: ClickRecord = {
    target: state.nextTarget,
    rtMs,
    cumMs,
    correct,
    clicked: correct ? undefined : value,
    tAbs: now,
  }

  if (!correct) {
    return {
      state: {
        ...state,
        errors: state.errors + 1,
        clicks: [...state.clicks, record],
        // Wrong click still advances the RT clock from this moment
        lastClickAt: now,
      },
      record,
    }
  }

  const nextTarget = state.nextTarget + 1
  const done = nextTarget > totalCells(state.size)
  return {
    state: {
      ...state,
      nextTarget: done ? state.nextTarget : nextTarget,
      clicks: [...state.clicks, record],
      lastClickAt: now,
      status: done ? 'done' : 'running',
    },
    record,
  }
}

/** Correct-click RTs only — primary focus/attention series. */
export function correctRtSeries(clicks: ClickRecord[]): Array<{ target: number; rtMs: number; cumMs: number }> {
  return clicks.filter((c) => c.correct).map((c) => ({
    target: c.target,
    rtMs: c.rtMs,
    cumMs: c.cumMs,
  }))
}

export function trialSummary(state: SchulteTrialState): {
  totalMs: number | null
  meanRtMs: number | null
  medianRtMs: number | null
  maxRtMs: number | null
  errors: number
  nCorrect: number
} {
  const series = correctRtSeries(state.clicks)
  if (!series.length) {
    return {
      totalMs: null,
      meanRtMs: null,
      medianRtMs: null,
      maxRtMs: null,
      errors: state.errors,
      nCorrect: 0,
    }
  }
  const rts = series.map((s) => s.rtMs).sort((a, b) => a - b)
  const sum = rts.reduce((a, b) => a + b, 0)
  const mid = Math.floor(rts.length / 2)
  const median =
    rts.length % 2 === 0 ? (rts[mid - 1]! + rts[mid]!) / 2 : rts[mid]!
  return {
    totalMs: series[series.length - 1]!.cumMs,
    meanRtMs: sum / rts.length,
    medianRtMs: median,
    maxRtMs: rts[rts.length - 1]!,
    errors: state.errors,
    nCorrect: series.length,
  }
}

/**
 * Rolling focus score 0–100 from recent correct RTs:
 * faster relative to own median → higher focus.
 */
export function rollingFocusScore(
  clicks: ClickRecord[],
  window = 5,
): number | null {
  const series = correctRtSeries(clicks)
  if (series.length < 2) return null
  const all = series.map((s) => s.rtMs)
  const sorted = [...all].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]!
  const recent = series.slice(-window)
  const meanRecent = recent.reduce((a, s) => a + s.rtMs, 0) / recent.length
  // med/mean → >1 when recent is faster than median
  const ratio = med / Math.max(1, meanRecent)
  const score = 100 / (1 + Math.exp(-2.2 * (ratio - 1)))
  return Math.max(0, Math.min(100, score))
}
