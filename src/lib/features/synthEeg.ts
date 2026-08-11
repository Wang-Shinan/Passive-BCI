/** Synthetic multi-band EEG for experiment pages (no hardware). */

export interface FeatureModulators {
  /** 0–100 stress / cognitive load proxy */
  stress?: number
  /** 0–100 focus */
  focus?: number
  /** 0–100 arousal / engagement */
  arousal?: number
  /** 0–100 relaxation / satisfaction proxy */
  relaxation?: number
}

export const SYNTH_FS = 250
export const SYNTH_CHANNELS = 8

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/**
 * Push one multi-channel sample (μV) driven by slow oscillators + optional modulators.
 * Higher stress → more beta/gamma, less alpha; higher focus → more beta; etc.
 */
export function synthEegSample(
  tSec: number,
  modulators: FeatureModulators = {},
): Float32Array {
  const stress = clamp01((modulators.stress ?? 40) / 100)
  const focus = clamp01((modulators.focus ?? 55) / 100)
  const arousal = clamp01((modulators.arousal ?? 45) / 100)
  const relax = clamp01((modulators.relaxation ?? 50) / 100)

  const envDelta = 0.22 + 0.28 * Math.sin(2 * Math.PI * 0.03 * tSec + 2.1) + 0.15 * (1 - arousal)
  const envTheta =
    0.35 +
    0.35 * Math.sin(2 * Math.PI * 0.05 * tSec + 0.6) +
    0.25 * stress * (1 - focus)
  const envAlpha =
    0.35 +
    0.4 * Math.sin(2 * Math.PI * 0.07 * tSec) +
    0.35 * relax -
    0.35 * stress
  const envBeta =
    0.25 +
    0.35 * Math.sin(2 * Math.PI * 0.11 * tSec + 1.2) +
    0.4 * stress +
    0.25 * focus +
    0.15 * arousal
  const envGamma =
    0.12 +
    0.2 * Math.sin(2 * Math.PI * 0.13 * tSec + 0.3) +
    0.25 * arousal +
    0.15 * stress

  const uv = new Float32Array(SYNTH_CHANNELS)
  for (let c = 0; c < SYNTH_CHANNELS; c++) {
    const phaseCh = c * 0.37
    uv[c] =
      Math.max(0.05, envDelta) * 18 * Math.sin(2 * Math.PI * (2.2 + c * 0.05) * tSec + phaseCh) +
      Math.max(0.05, envTheta) * 14 * Math.sin(2 * Math.PI * (6.0 + c * 0.08) * tSec + phaseCh) +
      Math.max(0.05, envAlpha) * 22 * Math.sin(2 * Math.PI * (10.0 + c * 0.12) * tSec + phaseCh) +
      Math.max(0.05, envBeta) * 12 * Math.sin(2 * Math.PI * (20.0 + c * 0.2) * tSec + phaseCh) +
      Math.max(0.05, envGamma) * 6 * Math.sin(2 * Math.PI * (36.0 + c * 0.15) * tSec + phaseCh) +
      (Math.random() - 0.5) * 5
  }
  return uv
}

/**
 * Independent drifting modulators for feature→control mode
 * (avoids feedback: control output must not drive the synth that produces it).
 * Wide, fast-enough stress swing so Tetris gravity visibly reacts (~12s cycle).
 */
export function autonomousModulators(tSec: number): FeatureModulators {
  return {
    stress: 50 + 40 * Math.sin(2 * Math.PI * 0.085 * tSec),
    focus: 50 + 35 * Math.sin(2 * Math.PI * 0.06 * tSec + 1.1),
    arousal: 48 + 32 * Math.sin(2 * Math.PI * 0.09 * tSec + 2.0),
    relaxation: 50 + 36 * Math.sin(2 * Math.PI * 0.045 * tSec + 0.4),
  }
}

export function makeSynthRing(seconds = 4): {
  buffers: Float32Array[]
  capacity: number
  writeHead: number
  filled: number
} {
  const capacity = Math.floor(SYNTH_FS * seconds)
  return {
    buffers: Array.from({ length: SYNTH_CHANNELS }, () => new Float32Array(capacity)),
    capacity,
    writeHead: 0,
    filled: 0,
  }
}

export function pushSynthFrame(
  ring: {
    buffers: Float32Array[]
    capacity: number
    writeHead: number
    filled: number
  },
  sample: Float32Array,
): void {
  const i = ring.writeHead
  for (let c = 0; c < ring.buffers.length; c++) {
    ring.buffers[c]![i] = sample[c] ?? 0
  }
  ring.writeHead = (i + 1) % ring.capacity
  ring.filled = Math.min(ring.capacity, ring.filled + 1)
}
