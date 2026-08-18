/** Live sliding-window EEG features aligned with epoch_feature_extraction.py. */

import {
  BAND_NAMES,
  FREQ_BANDS,
  softScore,
  type BandName,
} from './featureCatalog'

export { softScore as scoreToPercent }

export type BandPowers = Record<BandName, number>

export interface LiveFeatureSnapshot {
  t: number
  nChannels: number
  windowSec: number
  /** Channel-mean scalar metrics keyed by catalog / expand ids. */
  values: Record<string, number>
}

const EPS = 1e-12
const HEAVY_CH_CAP = 8
/** BCIGo disconnected-lead sentinel (μV). */
export const EEG_LEAD_OFF_SENTINEL_UV = -750000
const SENTINEL_ABS_UV = 1e5

function normalizeChName(name: string | undefined): string {
  return (name ?? '').replace(/\s+/g, '').toUpperCase()
}

export function isNonScalpEegChannel(name?: string, type?: string): boolean {
  const t = (type ?? '').replace(/\s+/g, '').toUpperCase()
  if (t === 'EOG' || t === 'ECG' || t === 'EMG' || t === 'REF' || t === 'GND') return true
  const n = normalizeChName(name)
  return n === 'IO' || n === 'EOG' || n === 'ECG' || n === 'REF' || n === 'GND' || n.startsWith('EOG')
}

function sliceLooksLeadOff(slice: Float32Array): boolean {
  if (!slice.length) return true
  let bad = 0
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i]!
    if (
      !Number.isFinite(v) ||
      Math.abs(v - EEG_LEAD_OFF_SENTINEL_UV) < 1 ||
      Math.abs(v) > SENTINEL_ABS_UV
    ) {
      bad += 1
    }
  }
  return bad > slice.length * 0.5
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

function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  if (n === 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  return w
}

function bandPowerFromPsd(
  psd: Float64Array,
  freqHz: Float64Array,
  lo: number,
  hi: number,
): number {
  let sum = 0
  for (let i = 0; i < psd.length; i++) {
    const f = freqHz[i]!
    if (f >= lo && f < hi) sum += psd[i]!
  }
  return sum
}

function channelPsd(
  samples: Float32Array,
  sampleRate: number,
): { psd: Float64Array; freq: Float64Array } | null {
  const n = samples.length
  if (n < 16) return null
  let mean = 0
  for (let i = 0; i < n; i++) mean += samples[i]!
  mean /= n

  const nfft = nextPow2(n)
  const re = new Float64Array(nfft)
  const im = new Float64Array(nfft)
  const win = hann(n)
  let winSumSq = 0
  for (let i = 0; i < n; i++) {
    re[i] = (samples[i]! - mean) * win[i]!
    winSumSq += win[i]! * win[i]!
  }
  fft(re, im)

  const half = nfft / 2
  const psd = new Float64Array(half + 1)
  const freq = new Float64Array(half + 1)
  const scale = 2 / (sampleRate * Math.max(winSumSq, EPS))
  for (let k = 0; k <= half; k++) {
    const power = re[k]! * re[k]! + im[k]! * im[k]!
    psd[k] = power * (k === 0 || k === half ? scale / 2 : scale)
    freq[k] = (k * sampleRate) / nfft
  }
  return { psd, freq }
}

function diff1(x: Float32Array): Float64Array {
  const d = new Float64Array(Math.max(0, x.length - 1))
  for (let i = 0; i < d.length; i++) d[i] = x[i + 1]! - x[i]!
  return d
}

function varianceOf(arr: ArrayLike<number>, mean?: number): number {
  const n = arr.length
  if (n < 2) return 0
  let m = mean
  if (m === undefined) {
    m = 0
    for (let i = 0; i < n; i++) m += arr[i]!
    m /= n
  }
  let s = 0
  for (let i = 0; i < n; i++) {
    const d = arr[i]! - m
    s += d * d
  }
  return s / (n - 1)
}

function meanOf(arr: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[i]!
  return s / Math.max(1, arr.length)
}

function subsampleChannels(idxs: number[], cap: number): number[] {
  if (idxs.length <= cap) return idxs
  const out: number[] = []
  for (let i = 0; i < cap; i++) {
    out.push(idxs[Math.floor((i * (idxs.length - 1)) / (cap - 1))]!)
  }
  return out
}

function linearRegressionSlope(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]!
    sy += ys[i]!
    sxx += xs[i]! * xs[i]!
    sxy += xs[i]! * ys[i]!
  }
  const den = n * sxx - sx * sx
  if (Math.abs(den) < EPS) return 0
  return (n * sxy - sx * sy) / den
}

/** Spectral edge frequency (default 0.95). */
function spectEdgeFreq(psd: Float64Array, freq: Float64Array, edge = 0.95): number {
  let total = 0
  for (let i = 0; i < psd.length; i++) {
    if (freq[i]! >= 1) total += psd[i]!
  }
  if (total < EPS) return 0
  let acc = 0
  const target = edge * total
  for (let i = 0; i < psd.length; i++) {
    if (freq[i]! < 1) continue
    acc += psd[i]!
    if (acc >= target) return freq[i]!
  }
  return freq[freq.length - 1] ?? 0
}

function spectSlope(psd: Float64Array, freq: Float64Array): number {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < psd.length; i++) {
    const f = freq[i]!
    const p = psd[i]!
    if (f < 1 || f > 40 || p <= EPS) continue
    xs.push(Math.log(f))
    ys.push(Math.log(p))
  }
  return linearRegressionSlope(xs, ys)
}

function teagerKaiserMean(x: Float32Array): number {
  if (x.length < 3) return 0
  let s = 0
  let n = 0
  for (let i = 1; i < x.length - 1; i++) {
    s += x[i]! * x[i]! - x[i - 1]! * x[i + 1]!
    n++
  }
  return n ? s / n : 0
}

function permEntropy(x: Float32Array, order = 3, delay = 1): number {
  const n = x.length
  const nPatterns = n - (order - 1) * delay
  if (nPatterns < 8) return 0
  const counts = new Map<string, number>()
  const idx = Array.from({ length: order }, (_, i) => i)
  for (let i = 0; i < nPatterns; i++) {
    const vals = idx.map((k) => x[i + k * delay]!)
    const rank = idx.slice().sort((a, b) => vals[a]! - vals[b]! || a - b)
    const key = rank.join(',')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let h = 0
  for (const c of counts.values()) {
    const p = c / nPatterns
    if (p > EPS) h -= p * Math.log(p)
  }
  return h / Math.log(factorial(order))
}

function factorial(n: number): number {
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}

function petrosianFd(x: Float32Array): number {
  const n = x.length
  if (n < 3) return 0
  let nDelta = 0
  for (let i = 0; i < n - 2; i++) {
    const d1 = x[i + 1]! - x[i]!
    const d2 = x[i + 2]! - x[i + 1]!
    if (d1 * d2 < 0) nDelta++
  }
  return Math.log10(n) / (Math.log10(n) + Math.log10(n / (n + 0.4 * nDelta)))
}

function katzFd(x: Float32Array): number {
  const n = x.length
  if (n < 2) return 0
  let length = 0
  let maxDist = 0
  const x0 = x[0]!
  for (let i = 1; i < n; i++) {
    const dx = 1
    const dy = x[i]! - x[i - 1]!
    length += Math.hypot(dx, dy)
    maxDist = Math.max(maxDist, Math.abs(x[i]! - x0))
  }
  if (length < EPS || maxDist < EPS) return 0
  return Math.log10(n - 1) / (Math.log10((n - 1) * maxDist / length) + Math.log10(n - 1))
}

/** Higuchi FD with k_max=6 (lightweight). */
function higuchiFd(x: Float32Array, kMax = 6): number {
  const n = x.length
  if (n < kMax * 2) return 0
  const lk: number[] = []
  const lnk: number[] = []
  for (let k = 1; k <= kMax; k++) {
    let lkSum = 0
    for (let m = 0; m < k; m++) {
      let L = 0
      const maxI = Math.floor((n - m - 1) / k)
      if (maxI < 1) continue
      for (let i = 1; i <= maxI; i++) {
        L += Math.abs(x[m + i * k]! - x[m + (i - 1) * k]!)
      }
      L = (L * (n - 1)) / (maxI * k * k)
      lkSum += L
    }
    const Lmean = lkSum / k
    if (Lmean > EPS) {
      lk.push(Math.log(Lmean))
      lnk.push(Math.log(1 / k))
    }
  }
  return -linearRegressionSlope(lnk, lk)
}

/** Simplified R/S Hurst. */
function hurstExp(x: Float32Array): number {
  const n = x.length
  if (n < 32) return 0.5
  const mean = meanOf(x)
  const y = new Float64Array(n)
  let c = 0
  for (let i = 0; i < n; i++) {
    c += x[i]! - mean
    y[i] = c
  }
  let maxY = -Infinity
  let minY = Infinity
  for (let i = 0; i < n; i++) {
    maxY = Math.max(maxY, y[i]!)
    minY = Math.min(minY, y[i]!)
  }
  const r = maxY - minY
  const s = Math.sqrt(varianceOf(x, mean))
  if (s < EPS || r < EPS) return 0.5
  return Math.log(r / s) / Math.log(n)
}

/** Lightweight DFA (few window sizes). */
function dfaExponent(x: Float32Array): number {
  const n = x.length
  if (n < 64) return 0.5
  const mean = meanOf(x)
  const profile = new Float64Array(n)
  let c = 0
  for (let i = 0; i < n; i++) {
    c += x[i]! - mean
    profile[i] = c
  }
  const scales = [8, 16, 32, 64].filter((w) => w * 2 < n)
  if (scales.length < 2) return 0.5
  const logN: number[] = []
  const logF: number[] = []
  for (const w of scales) {
    const nSeg = Math.floor(n / w)
    if (nSeg < 1) continue
    let f2 = 0
    for (let s = 0; s < nSeg; s++) {
      const start = s * w
      const xs: number[] = []
      const ys: number[] = []
      for (let i = 0; i < w; i++) {
        xs.push(i)
        ys.push(profile[start + i]!)
      }
      const slope = linearRegressionSlope(xs, ys)
      const intercept = meanOf(ys) - slope * meanOf(xs)
      let err = 0
      for (let i = 0; i < w; i++) {
        const fit = intercept + slope * i
        const d = profile[start + i]! - fit
        err += d * d
      }
      f2 += err / w
    }
    const f = Math.sqrt(f2 / nSeg)
    if (f > EPS) {
      logN.push(Math.log(w))
      logF.push(Math.log(f))
    }
  }
  return linearRegressionSlope(logN, logF)
}

/** Binary Lempel–Ziv complexity (normalized). */
function lzivComplexity(x: Float32Array): number {
  const n = x.length
  if (n < 8) return 0
  const med = medianOf(x)
  const bits: number[] = []
  for (let i = 0; i < n; i++) bits.push(x[i]! > med ? 1 : 0)
  let complexity = 1
  let prefixLen = 1
  let i = 0
  while (prefixLen + i < n) {
    let matched = false
    for (let j = 0; j < prefixLen; j++) {
      let k = 0
      while (
        k <= i &&
        prefixLen + k < n &&
        bits[j + k] === bits[prefixLen + k]
      ) {
        k++
      }
      if (k > i) {
        matched = true
        i++
        break
      }
    }
    if (!matched) {
      complexity++
      prefixLen += i + 1
      i = 0
    }
  }
  const b = n / Math.log2(n)
  return complexity / b
}

function medianOf(x: ArrayLike<number>): number {
  const n = x.length
  if (!n) return Number.NaN
  const a = Array.from(x).sort((u, v) => u - v)
  const m = n >> 1
  return n % 2 ? a[m]! : 0.5 * (a[m - 1]! + a[m]!)
}

/** Approximate entropy (Pincus), m=2. */
function appEntropy(x: Float32Array, m = 2, rScale = 0.2): number {
  const n = x.length
  if (n < 40) return 0
  const sd = Math.sqrt(varianceOf(x))
  const r = rScale * sd
  if (r < EPS) return 0

  const phi = (mm: number): number => {
    const count = n - mm + 1
    let sum = 0
    for (let i = 0; i < count; i++) {
      let c = 0
      for (let j = 0; j < count; j++) {
        let maxd = 0
        for (let k = 0; k < mm; k++) {
          maxd = Math.max(maxd, Math.abs(x[i + k]! - x[j + k]!))
        }
        if (maxd <= r) c++
      }
      sum += Math.log(c / count)
    }
    return sum / count
  }
  return phi(m) - phi(m + 1)
}

/** Sample entropy, m=2 — O(n²), use downsampled window. */
function sampEntropy(x: Float32Array, m = 2, rScale = 0.2): number {
  const maxN = 120
  let series = x
  if (x.length > maxN) {
    const step = Math.ceil(x.length / maxN)
    const ds = new Float32Array(Math.floor(x.length / step))
    for (let i = 0; i < ds.length; i++) ds[i] = x[i * step]!
    series = ds
  }
  const n = series.length
  if (n < 40) return 0
  const sd = Math.sqrt(varianceOf(series))
  const r = rScale * sd
  if (r < EPS) return 0

  const countMatches = (mm: number): number => {
    let count = 0
    const last = n - mm
    for (let i = 0; i < last; i++) {
      for (let j = i + 1; j < last; j++) {
        let maxd = 0
        for (let k = 0; k < mm; k++) {
          maxd = Math.max(maxd, Math.abs(series[i + k]! - series[j + k]!))
          if (maxd > r) break
        }
        if (maxd <= r) count++
      }
    }
    return count
  }
  const b = countMatches(m)
  const a = countMatches(m + 1)
  if (b < 1 || a < 1) return 0
  return -Math.log(a / b)
}

/** SVD entropy / Fisher info on embedding matrix (m=3). */
function svdEntropyFisher(x: Float32Array, m = 3, tau = 1): { entropy: number; fisher: number } {
  const n = x.length - (m - 1) * tau
  if (n < m + 2) return { entropy: 0, fisher: 0 }
  // Build n x m matrix, compute Gram eigenvalues (lighter than full SVD)
  const gram = Array.from({ length: m }, () => new Float64Array(m))
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < m; a++) {
      for (let b = 0; b < m; b++) {
        gram[a]![b]! += x[i + a * tau]! * x[i + b * tau]!
      }
    }
  }
  for (let a = 0; a < m; a++) {
    for (let b = 0; b < m; b++) gram[a]![b]! /= n
  }
  const eigs = eigenSymmetric3orLess(gram)
  const sum = eigs.reduce((s, v) => s + Math.max(0, v), 0) + EPS
  const p = eigs.map((v) => Math.max(0, v) / sum)
  let h = 0
  for (const pi of p) if (pi > EPS) h -= pi * Math.log(pi)
  const entropy = h / Math.log(m)
  let fisher = 0
  for (const pi of p) if (pi > EPS) fisher += (1 / pi) * ((pi - 1 / m) * (pi - 1 / m))
  return { entropy, fisher }
}

function eigenSymmetric3orLess(A: Float64Array[]): number[] {
  const m = A.length
  // Power iteration for top eigenvalues + deflation (enough for entropy)
  const mat = A.map((row) => Float64Array.from(row))
  const eigs: number[] = []
  for (let k = 0; k < m; k++) {
    let v = new Float64Array(m)
    for (let i = 0; i < m; i++) v[i] = Math.random() + 0.1
    let lambda = 0
    for (let it = 0; it < 40; it++) {
      const Av = new Float64Array(m)
      for (let i = 0; i < m; i++) {
        let s = 0
        for (let j = 0; j < m; j++) s += mat[i]![j]! * v[j]!
        Av[i] = s
      }
      let norm = 0
      for (let i = 0; i < m; i++) norm += Av[i]! * Av[i]!
      norm = Math.sqrt(norm) + EPS
      for (let i = 0; i < m; i++) v[i] = Av[i]! / norm
      lambda = 0
      for (let i = 0; i < m; i++) {
        let s = 0
        for (let j = 0; j < m; j++) s += mat[i]![j]! * v[j]!
        lambda += v[i]! * s
      }
    }
    eigs.push(Math.max(0, lambda))
    // Deflate
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) mat[i]![j]! -= lambda * v[i]! * v[j]!
    }
  }
  return eigs
}

function needSpectral(enabled: Set<string>): boolean {
  return (
    enabled.has('pow_freq_bands') ||
    enabled.has('energy_freq_bands') ||
    enabled.has('spect_entropy') ||
    enabled.has('spect_slope') ||
    enabled.has('spect_edge_freq') ||
    enabled.has('hjorth_mobility_spect') ||
    enabled.has('hjorth_complexity_spect') ||
    enabled.has('focus_score') ||
    enabled.has('engagement_score') ||
    enabled.has('relaxation_score') ||
    enabled.has('cognitive_load') ||
    enabled.has('drowsiness') ||
    enabled.has('tbr_theta_beta') ||
    enabled.has('tar_theta_alpha') ||
    enabled.has('bar_beta_alpha')
  )
}

function needHeavy(enabled: Set<string>): boolean {
  return (
    enabled.has('svd_entropy') ||
    enabled.has('svd_fisher_info') ||
    enabled.has('app_entropy') ||
    enabled.has('samp_entropy') ||
    enabled.has('hurst_exp') ||
    enabled.has('higuchi_fd') ||
    enabled.has('dfa_exponent') ||
    enabled.has('lziv_complexity')
  )
}

/**
 * Compute channel-averaged live features for the enabled catalog ids.
 */
export function computeLiveFeatures(opts: {
  buffers: Float32Array[]
  writeHead: number
  filled: number
  sampleRate: number
  windowSec?: number
  channelMask?: boolean[]
  channelNames?: string[]
  channelTypes?: string[]
  enabledFeatures?: string[]
}): LiveFeatureSnapshot | null {
  const {
    buffers,
    writeHead,
    filled,
    sampleRate,
    windowSec = 1.0,
    channelMask,
    channelNames,
    channelTypes,
    enabledFeatures,
  } = opts
  if (!buffers.length || filled < 16) return null

  const enabled = new Set(
    enabledFeatures?.length
      ? enabledFeatures
      : [
          'mean',
          'std',
          'rms',
          'pow_freq_bands',
          'spect_entropy',
          'focus_score',
          'engagement_score',
          'relaxation_score',
          'cognitive_load',
          'drowsiness',
        ],
  )

  const winSamples = Math.min(filled, Math.max(16, Math.floor(windowSec * sampleRate)))
  const bufLen = buffers[0]!.length
  const usedIdx: number[] = []
  const consider = (c: number, honorMask: boolean) => {
    if (honorMask && channelMask && channelMask[c] === false) return
    if (isNonScalpEegChannel(channelNames?.[c], channelTypes?.[c])) return
    usedIdx.push(c)
  }
  for (let c = 0; c < buffers.length; c++) consider(c, true)
  if (!usedIdx.length) {
    for (let c = 0; c < buffers.length; c++) consider(c, false)
  }

  const heavyIdx = needHeavy(enabled) ? subsampleChannels(usedIdx, HEAVY_CH_CAP) : []
  const wantSpec = needSpectral(enabled)
  const specIdx = wantSpec ? subsampleChannels(usedIdx, HEAVY_CH_CAP) : []
  const specSet = new Set(specIdx)
  const needScores =
    enabled.has('focus_score') ||
    enabled.has('engagement_score') ||
    enabled.has('relaxation_score') ||
    enabled.has('cognitive_load') ||
    enabled.has('drowsiness') ||
    enabled.has('tbr_theta_beta') ||
    enabled.has('tar_theta_alpha') ||
    enabled.has('bar_beta_alpha')

  const acc: Record<string, number> = {}
  const bump = (key: string, v: number) => {
    acc[key] = (acc[key] ?? 0) + v
  }

  let nOk = 0
  let nSpec = 0
  let nHeavy = 0
  const engCh: number[] = []
  const relaxCh: number[] = []
  const cogCh: number[] = []
  const drowCh: number[] = []
  const tbrCh: number[] = []
  const tarCh: number[] = []
  const barCh: number[] = []

  for (const c of usedIdx) {
    const buf = buffers[c]!
    const slice = new Float32Array(winSamples)
    for (let i = 0; i < winSamples; i++) {
      const idx = (((writeHead - winSamples + i) % bufLen) + bufLen) % bufLen
      slice[i] = buf[idx]!
    }
    if (sliceLooksLeadOff(slice)) continue

    const mean = meanOf(slice)
    const variance = varianceOf(slice, mean)
    const std = Math.sqrt(variance)
    let sumSq = 0
    let min = Infinity
    let max = -Infinity
    let m3 = 0
    let m4 = 0
    let line = 0
    let zc = 0
    for (let i = 0; i < winSamples; i++) {
      const v = slice[i]!
      sumSq += v * v
      if (v < min) min = v
      if (v > max) max = v
      const d = v - mean
      m3 += d * d * d
      m4 += d * d * d * d
      if (i > 0) {
        line += Math.abs(v - slice[i - 1]!)
        if ((slice[i - 1]! - mean) * (v - mean) < 0) zc++
      }
    }
    const rms = Math.sqrt(sumSq / winSamples)
    const skewness = std > EPS ? m3 / winSamples / (std * std * std) : 0
    const kurtosis = std > EPS ? m4 / winSamples / (std * std * std * std) - 3 : 0

    const d1 = diff1(slice)
    const d2 = diff1(new Float32Array(d1))
    const var0 = variance
    const var1 = varianceOf(d1)
    const var2 = varianceOf(d2)
    const mobility = var0 > EPS ? Math.sqrt(var1 / var0) : 0
    const mobilityD = var1 > EPS ? Math.sqrt(var2 / var1) : 0
    const complexity = mobility > EPS ? mobilityD / mobility : 0

    if (enabled.has('mean')) bump('mean', mean)
    if (enabled.has('std')) bump('std', std)
    if (enabled.has('variance')) bump('variance', variance)
    if (enabled.has('rms')) bump('rms', rms)
    if (enabled.has('ptp_amp')) bump('ptp_amp', max - min)
    if (enabled.has('skewness')) bump('skewness', skewness)
    if (enabled.has('kurtosis')) bump('kurtosis', kurtosis)
    if (enabled.has('line_length')) bump('line_length', line)
    if (enabled.has('zero_crossings')) bump('zero_crossings', zc)
    if (enabled.has('hjorth_mobility')) bump('hjorth_mobility', mobility)
    if (enabled.has('hjorth_complexity')) bump('hjorth_complexity', complexity)
    if (enabled.has('teager_kaiser_energy')) bump('teager_kaiser_energy', teagerKaiserMean(slice))
    if (enabled.has('katz_fd')) bump('katz_fd', katzFd(slice))
    if (enabled.has('petrosian_fd')) bump('petrosian_fd', petrosianFd(slice))
    if (enabled.has('perm_entropy')) bump('perm_entropy', permEntropy(slice))

    if (wantSpec && specSet.has(c)) {
      const spec = channelPsd(slice, sampleRate)
      if (spec) {
        const { psd, freq } = spec
        const absBands: BandPowers = {
          delta: 0,
          theta: 0,
          alpha: 0,
          beta: 0,
          gamma: 0,
          gamma_plus: 0,
        }
        for (const b of BAND_NAMES) {
          const [lo, hi] = FREQ_BANDS[b]
          absBands[b] = bandPowerFromPsd(psd, freq, lo, hi)
        }
        const bandTotal =
          absBands.delta +
          absBands.theta +
          absBands.alpha +
          absBands.beta +
          absBands.gamma +
          absBands.gamma_plus +
          EPS

        const delta = absBands.delta / bandTotal
        const theta = absBands.theta / bandTotal
        const alpha = absBands.alpha / bandTotal
        const beta = absBands.beta / bandTotal

        if (enabled.has('pow_freq_bands') || needSpectral(enabled)) {
          for (const b of BAND_NAMES) bump(`rel_power_${b}`, absBands[b] / bandTotal)
        }
        if (needScores) {
          engCh.push(beta / (alpha + theta + EPS))
          relaxCh.push(alpha / (beta + theta + EPS))
          cogCh.push(theta / (alpha + EPS))
          drowCh.push((theta + delta) / (alpha + beta + EPS))
          tbrCh.push(theta / (beta + EPS))
          tarCh.push(theta / (alpha + EPS))
          barCh.push(beta / (alpha + EPS))
        }
        if (enabled.has('energy_freq_bands')) {
          for (const b of BAND_NAMES) bump(`energy_${b}`, absBands[b])
        }
        if (enabled.has('spect_entropy')) {
          let total = 0
          for (let i = 0; i < psd.length; i++) {
            const f = freq[i]!
            if (f >= 1 && f < 45) total += psd[i]!
          }
          let h = 0
          let nBins = 0
          if (total > EPS) {
            for (let i = 0; i < psd.length; i++) {
              const f = freq[i]!
              if (f < 1 || f >= 45) continue
              nBins++
              const p = psd[i]! / total
              if (p > EPS) h -= p * Math.log(p)
            }
            bump('spect_entropy', nBins > 1 ? h / Math.log(nBins) : 0)
          }
        }
        if (enabled.has('spect_slope')) bump('spect_slope', spectSlope(psd, freq))
        if (enabled.has('spect_edge_freq')) bump('spect_edge_freq', spectEdgeFreq(psd, freq))

        if (enabled.has('hjorth_mobility_spect') || enabled.has('hjorth_complexity_spect')) {
          // Spectral Hjorth from moments of PSD
          let m0 = 0
          let m2 = 0
          let m4 = 0
          for (let i = 0; i < psd.length; i++) {
            const f = freq[i]!
            if (f < 1 || f > 45) continue
            const w = 2 * Math.PI * f
            m0 += psd[i]!
            m2 += psd[i]! * w * w
            m4 += psd[i]! * w * w * w * w
          }
          const mob = m0 > EPS ? Math.sqrt(m2 / m0) : 0
          const mob2 = m2 > EPS ? Math.sqrt(m4 / m2) : 0
          if (enabled.has('hjorth_mobility_spect')) bump('hjorth_mobility_spect', mob)
          if (enabled.has('hjorth_complexity_spect')) {
            bump('hjorth_complexity_spect', mob > EPS ? mob2 / mob : 0)
          }
        }
        nSpec++
      }
    }

    if (heavyIdx.includes(c)) {
      if (enabled.has('svd_entropy') || enabled.has('svd_fisher_info')) {
        const { entropy, fisher } = svdEntropyFisher(slice)
        if (enabled.has('svd_entropy')) bump('svd_entropy', entropy)
        if (enabled.has('svd_fisher_info')) bump('svd_fisher_info', fisher)
      }
      if (enabled.has('app_entropy')) bump('app_entropy', appEntropy(slice))
      if (enabled.has('samp_entropy')) bump('samp_entropy', sampEntropy(slice))
      if (enabled.has('hurst_exp')) bump('hurst_exp', hurstExp(slice))
      if (enabled.has('higuchi_fd')) bump('higuchi_fd', higuchiFd(slice))
      if (enabled.has('dfa_exponent')) bump('dfa_exponent', dfaExponent(slice))
      if (enabled.has('lziv_complexity')) bump('lziv_complexity', lzivComplexity(slice))
      nHeavy++
    }

    nOk++
  }

  if (!nOk) return null

  const values: Record<string, number> = {}
  for (const [k, v] of Object.entries(acc)) {
    const denom =
      k.startsWith('rel_power_') ||
      k.startsWith('energy_') ||
      k === 'spect_entropy' ||
      k === 'spect_slope' ||
      k === 'spect_edge_freq' ||
      k === 'hjorth_mobility_spect' ||
      k === 'hjorth_complexity_spect'
        ? Math.max(1, nSpec)
        : k === 'svd_entropy' ||
            k === 'svd_fisher_info' ||
            k === 'app_entropy' ||
            k === 'samp_entropy' ||
            k === 'hurst_exp' ||
            k === 'higuchi_fd' ||
            k === 'dfa_exponent' ||
            k === 'lziv_complexity'
          ? Math.max(1, nHeavy)
          : nOk
    values[k] = v / denom
  }

  // Derived scores: median of per-channel ratios. Averaging 32–64 relative
  // band powers first made β/(α+θ) a near-constant.
  if (needScores && engCh.length) {
    if (enabled.has('focus_score')) values.focus_score = medianOf(engCh)
    if (enabled.has('engagement_score')) values.engagement_score = medianOf(engCh)
    if (enabled.has('relaxation_score')) values.relaxation_score = medianOf(relaxCh)
    if (enabled.has('cognitive_load')) values.cognitive_load = medianOf(cogCh)
    if (enabled.has('drowsiness')) values.drowsiness = medianOf(drowCh)
    if (enabled.has('tbr_theta_beta')) values.tbr_theta_beta = medianOf(tbrCh)
    if (enabled.has('tar_theta_alpha')) values.tar_theta_alpha = medianOf(tarCh)
    if (enabled.has('bar_beta_alpha')) values.bar_beta_alpha = medianOf(barCh)
  }

  // Drop band keys if pow_freq_bands not enabled (kept temporarily for scores).
  if (!enabled.has('pow_freq_bands')) {
    for (const b of BAND_NAMES) delete values[`rel_power_${b}`]
  }

  return {
    t: performance.now(),
    nChannels: nOk,
    windowSec,
    values,
  }
}

/** @deprecated kept for older panel score mapping */
export function scoreToPercentLegacy(raw: number, scale = 1): number {
  return softScore(raw, scale)
}
