/** Stieger-style SMR cursor: C3/C4 Laplacian alpha → 2D velocity. */

export const SMR_WINDOW_SEC = 0.16
export const SMR_ALPHA_CENTER_HZ = 12
export const SMR_ALPHA_BAND_HZ = 3
export const SMR_TICK_SEC = 0.04
export const SMR_BUFFER_SEC = 30
export const SMR_GAIN = 0.85
export const SMR_MIN_STD = 0.05

export type TargetDir = 'right' | 'left' | 'up' | 'down'
export type SmrTask = 'LR' | 'UD' | '2D'

const C3_NEIGHBOR_SETS = [
  ['FC3', 'C1', 'C5', 'CP3'],
  ['FC1', 'FC5', 'CP1', 'CP5'],
  ['FC5', 'CP5', 'T7', 'Cz'],
] as const

const C4_NEIGHBOR_SETS = [
  ['FC4', 'C2', 'C6', 'CP4'],
  ['FC2', 'FC6', 'CP2', 'CP6'],
  ['FC6', 'CP6', 'T8', 'Cz'],
] as const

export function normalizeChannelName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase()
}

export function indexByChannelName(names: readonly string[]): Map<string, number> {
  const map = new Map<string, number>()
  names.forEach((name, index) => map.set(normalizeChannelName(name), index))
  return map
}

export function pickNeighbors(
  names: readonly string[],
  sets: readonly (readonly string[])[],
): string[] {
  const have = new Set(names.map(normalizeChannelName))
  for (const set of sets) {
    const hit = set.map(normalizeChannelName).filter((name) => have.has(name))
    if (hit.length >= 2) return hit.slice(0, 4)
  }
  return []
}

export type LaplacianMontage = {
  c3: number
  c4: number
  neighborsC3: number[]
  neighborsC4: number[]
  neighborNamesC3: string[]
  neighborNamesC4: string[]
}

export function resolveLaplacianMontage(names: readonly string[]): LaplacianMontage | null {
  const index = indexByChannelName(names)
  const c3 = index.get('C3')
  const c4 = index.get('C4')
  if (c3 == null || c4 == null) return null
  const neighborNamesC3 = pickNeighbors(names, C3_NEIGHBOR_SETS)
  const neighborNamesC4 = pickNeighbors(names, C4_NEIGHBOR_SETS)
  return {
    c3,
    c4,
    neighborsC3: neighborNamesC3.map((name) => index.get(name)!),
    neighborsC4: neighborNamesC4.map((name) => index.get(name)!),
    neighborNamesC3,
    neighborNamesC4,
  }
}

export function copyRecentSamples(
  buffer: Float32Array,
  writeHead: number,
  filled: number,
  n: number,
): Float32Array {
  const avail = Math.min(filled, buffer.length)
  const take = Math.min(Math.max(0, n), avail)
  const out = new Float32Array(take)
  if (take === 0) return out
  const start = (writeHead - take + buffer.length) % buffer.length
  for (let i = 0; i < take; i++) {
    out[i] = buffer[(start + i) % buffer.length]!
  }
  return out
}

export function laplacianTrace(
  center: Float32Array,
  neighbors: Float32Array[],
): Float32Array {
  const n = center.length
  const out = new Float32Array(n)
  if (neighbors.length === 0) {
    out.set(center)
    return out
  }
  const inv = 1 / neighbors.length
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const neighbor of neighbors) sum += neighbor[i] ?? 0
    out[i] = center[i]! - sum * inv
  }
  return out
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  let j = 0
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti
    }
    let m = n >> 1
    while (m >= 1 && j >= m) {
      j -= m
      m >>= 1
    }
    j += m
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wlenRe = Math.cos(ang)
    const wlenIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]!
        const uIm = im[i + k]!
        const vRe = re[i + k + len / 2]! * wRe - im[i + k + len / 2]! * wIm
        const vIm = re[i + k + len / 2]! * wIm + im[i + k + len / 2]! * wRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextWRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nextWRe
      }
    }
  }
}

function bandPowerFft(
  samples: ArrayLike<number>,
  sampleRate: number,
  loHz: number,
  hiHz: number,
): number {
  const n = samples.length
  if (n < 16 || sampleRate <= 0) return 0
  let mean = 0
  for (let i = 0; i < n; i++) mean += samples[i]!
  mean /= n
  const nfft = nextPow2(Math.max(n, 256))
  const re = new Float64Array(nfft)
  const im = new Float64Array(nfft)
  let winSumSq = 0
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)))
    re[i] = (samples[i]! - mean) * w
    winSumSq += w * w
  }
  fft(re, im)
  const scale = 2 / (sampleRate * Math.max(winSumSq, 1e-12))
  let sum = 0
  for (let k = 0; k <= nfft / 2; k++) {
    const f = (k * sampleRate) / nfft
    if (f < loHz || f >= hiHz) continue
    const power = re[k]! * re[k]! + im[k]! * im[k]!
    sum += power * (k === 0 || k === nfft / 2 ? scale / 2 : scale)
  }
  return sum
}

export function alphaPower(samples: ArrayLike<number>, sampleRate: number): number {
  const half = SMR_ALPHA_BAND_HZ / 2
  return bandPowerFft(
    samples,
    sampleRate,
    SMR_ALPHA_CENTER_HZ - half,
    SMR_ALPHA_CENTER_HZ + half,
  )
}

/** Physiology-signed Stieger features: left MI → negative H, rest → negative V. */
export function smrFeatures(pC3: number, pC4: number): { horiz: number; vert: number } {
  return {
    horiz: pC3 - pC4,
    vert: -(pC3 + pC4),
  }
}

/** +1 if pos-class mean is higher; -1 if the physiology-signed axis is inverted. */
export function polarityFromClassMeans(
  meanPos: number,
  meanNeg: number,
  std: number,
  minSep = 0.2,
): 1 | -1 | 0 {
  const gap = meanPos - meanNeg
  if (Math.abs(gap) < minSep * Math.max(std, SMR_MIN_STD)) return 0
  return gap > 0 ? 1 : -1
}

export class BalancedNorm {
  private readonly maxN: number
  private readonly a: number[] = []
  private readonly b: number[] = []
  private sign: 1 | -1 = 1
  private locked = false

  constructor(bufferSec = SMR_BUFFER_SEC, tickSec = SMR_TICK_SEC) {
    this.maxN = Math.max(8, Math.round(bufferSec / tickSec))
  }

  push(side: 'pos' | 'neg', value: number): void {
    const buf = side === 'pos' ? this.a : this.b
    buf.push(value)
    if (buf.length > this.maxN) buf.shift()
    this.updatePolarity()
  }

  polarity(): 1 | -1 {
    return this.sign
  }

  flipped(): boolean {
    return this.sign < 0
  }

  z(value: number): number {
    const stats = this.stats()
    if (!stats) return 0
    return (this.sign * (value - stats.mean)) / stats.std
  }

  stats(): { mean: number; std: number; nPos: number; nNeg: number } | null {
    if (this.a.length < 8 || this.b.length < 8) return null
    const meanA = meanOf(this.a)
    const meanB = meanOf(this.b)
    const varA = varianceOf(this.a, meanA)
    const varB = varianceOf(this.b, meanB)
    return {
      mean: 0.5 * (meanA + meanB),
      std: Math.max(SMR_MIN_STD, Math.sqrt(0.5 * (varA + varB))),
      nPos: this.a.length,
      nNeg: this.b.length,
    }
  }

  private updatePolarity(): void {
    if (this.locked || this.a.length < 80 || this.b.length < 80) return
    const meanA = meanOf(this.a)
    const meanB = meanOf(this.b)
    const std = Math.max(
      SMR_MIN_STD,
      Math.sqrt(0.5 * (varianceOf(this.a, meanA) + varianceOf(this.b, meanB))),
    )
    const next = polarityFromClassMeans(meanA, meanB, std)
    if (next === 0) return
    this.sign = next
    this.locked = true
  }
}

function meanOf(values: number[]): number {
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

function varianceOf(values: number[], mean: number): number {
  if (values.length < 2) return 0
  let s = 0
  for (const v of values) {
    const d = v - mean
    s += d * d
  }
  return s / (values.length - 1)
}

export function classSide(target: TargetDir, axis: 'horiz' | 'vert'): 'pos' | 'neg' | null {
  if (axis === 'horiz') {
    if (target === 'right') return 'pos'
    if (target === 'left') return 'neg'
    return null
  }
  if (target === 'up') return 'pos'
  if (target === 'down') return 'neg'
  return null
}

export type CursorState = { x: number; y: number }

export function resetCursor(): CursorState {
  return { x: 0.5, y: 0.5 }
}

export function stepCursor(
  cursor: CursorState,
  task: SmrTask,
  zH: number,
  zV: number,
  dtSec = SMR_TICK_SEC,
  gain = SMR_GAIN,
): CursorState {
  let x = cursor.x
  let y = cursor.y
  if (task !== 'UD') x += gain * zH * dtSec
  if (task !== 'LR') y += gain * zV * dtSec
  if (task === 'LR') y = 0.5
  if (task === 'UD') x = 0.5
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  }
}

export function hitEdge(cursor: CursorState, pad = 0.02): TargetDir | null {
  if (cursor.x <= pad) return 'left'
  if (cursor.x >= 1 - pad) return 'right'
  if (cursor.y <= pad) return 'down'
  if (cursor.y >= 1 - pad) return 'up'
  return null
}

export type TrialOutcome = 'hit' | 'miss' | 'timeout'

export function outcomeForHit(target: TargetDir, hit: TargetDir | null, timedOut: boolean): TrialOutcome {
  if (timedOut && hit == null) return 'timeout'
  if (hit == null) return 'timeout'
  return hit === target ? 'hit' : 'miss'
}

export function pvc(outcomes: readonly TrialOutcome[]): number {
  let hits = 0
  let valid = 0
  for (const outcome of outcomes) {
    if (outcome === 'timeout') continue
    valid++
    if (outcome === 'hit') hits++
  }
  return valid === 0 ? 0 : hits / valid
}

export function proficient(task: SmrTask, score: number): boolean {
  return task === '2D' ? score >= 0.4 : score >= 0.7
}
