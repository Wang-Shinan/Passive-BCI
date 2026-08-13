/** scipy.signal.welch-style one-sided density PSD (Hann, 75% overlap). */

export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length
  let j = 0
  for (let i = 0; i < n; i++) {
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
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
        const nRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nRe
      }
    }
  }
}

function linearDetrend(x: Float64Array): void {
  const n = x.length
  if (n < 2) return
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let i = 0; i < n; i++) {
    const y = x[i]!
    sumX += i
    sumY += y
    sumXY += i * y
    sumXX += i * i
  }
  const den = n * sumXX - sumX * sumX
  const slope = den === 0 ? 0 : (n * sumXY - sumX * sumY) / den
  const intercept = (sumY - slope * sumX) / n
  for (let i = 0; i < n; i++) x[i] = x[i]! - (intercept + slope * i)
}

/** Symmetric Hann, matching scipy.get_window('hann', n). */
function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  if (n === 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  return w
}

export type WelchResult = { f: Float64Array; p: Float64Array }

/**
 * One-sided density PSD. Defaults match Omni:
 * nperseg = 4·Fs, noverlap = 75%, nfft = max(2048, nextpow2(nperseg)), window=hann.
 */
export function welchPsd(
  xIn: ArrayLike<number>,
  fs: number,
  opts?: { nperseg?: number; noverlap?: number; nfft?: number },
): WelchResult | null {
  const n = xIn.length
  if (n < 32) return null
  const nperseg = Math.min(n, Math.max(32, opts?.nperseg ?? fs * 4))
  if (n < nperseg) return null
  const noverlap = opts?.noverlap ?? Math.floor((3 * nperseg) / 4)
  const step = Math.max(1, nperseg - noverlap)
  const nfft = nextPow2(Math.max(opts?.nfft ?? Math.max(2048, nperseg), nperseg))
  const win = hann(nperseg)
  let winSs = 0
  for (let i = 0; i < nperseg; i++) winSs += win[i]! * win[i]!
  const scale = 1 / (fs * winSs)

  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = xIn[i]!
  linearDetrend(x)

  const acc = new Float64Array(nfft / 2 + 1)
  let nSeg = 0
  for (let start = 0; start + nperseg <= n; start += step) {
    const re = new Float64Array(nfft)
    const im = new Float64Array(nfft)
    let mean = 0
    for (let i = 0; i < nperseg; i++) mean += x[start + i]!
    mean /= nperseg
    for (let i = 0; i < nperseg; i++) re[i] = (x[start + i]! - mean) * win[i]!
    fftInPlace(re, im)
    const half = nfft / 2
    acc[0] += (re[0]! * re[0]! + im[0]! * im[0]!) * scale
    for (let k = 1; k < half; k++) {
      acc[k] += 2 * (re[k]! * re[k]! + im[k]! * im[k]!) * scale
    }
    acc[half] += (re[half]! * re[half]! + im[half]! * im[half]!) * scale
    nSeg += 1
  }
  if (!nSeg) return null
  for (let k = 0; k < acc.length; k++) acc[k] /= nSeg
  const f = new Float64Array(acc.length)
  for (let k = 0; k < acc.length; k++) f[k] = (k * fs) / nfft
  return { f, p: acc }
}

export const PSD_SMOOTH_BETA = 0.65

export function smoothPsdDb(
  f: Float64Array,
  p: Float64Array,
  prev: { f: Float64Array; db: Float64Array } | null,
  beta = PSD_SMOOTH_BETA,
): { f: Float64Array; db: Float64Array } {
  const db = new Float64Array(p.length)
  const eps = Number.EPSILON
  for (let i = 0; i < p.length; i++) db[i] = 10 * Math.log10(p[i]! + eps)
  if (
    !prev ||
    prev.f.length !== f.length ||
    prev.f[prev.f.length - 1] !== f[f.length - 1]
  ) {
    return { f: Float64Array.from(f), db }
  }
  for (let i = 0; i < db.length; i++) db[i] = beta * prev.db[i]! + (1 - beta) * db[i]!
  return { f: prev.f, db }
}
