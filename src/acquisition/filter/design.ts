/** scipy-compatible causal IIR SOS: butter(2) bandpass + iirnotch Q=30. */

export type Sos = number[][] // [b0,b1,b2,a0,a1,a2] per section

type C = { re: number; im: number }

const ZERO: C = { re: 0, im: 0 }

function c(re: number, im = 0): C {
  return { re, im }
}

function cadd(a: C, b: C): C {
  return { re: a.re + b.re, im: a.im + b.im }
}

function csub(a: C, b: C): C {
  return { re: a.re - b.re, im: a.im - b.im }
}

function cmul(a: C, b: C): C {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

function cdiv(a: C, b: C): C {
  const d = b.re * b.re + b.im * b.im
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }
}

function carg(a: C): number {
  return Math.atan2(a.im, a.re)
}

/** Principal square root (numpy-compatible). */
function csqrt(a: C): C {
  const r = Math.hypot(a.re, a.im)
  const re = Math.sqrt(Math.max(0, (r + a.re) / 2))
  let im = Math.sqrt(Math.max(0, (r - a.re) / 2))
  if (a.im < 0) im = -im
  return { re, im }
}

function cprod(xs: C[]): C {
  return xs.reduce((acc, x) => cmul(acc, x), c(1))
}

/** Analog Butterworth prototype, matching scipy.signal.buttap. */
function buttap(n: number): { z: C[]; p: C[]; k: number } {
  const p: C[] = []
  for (let m = -n + 1; m < n; m += 2) {
    const theta = (Math.PI * m) / (2 * n)
    p.push({ re: -Math.cos(theta), im: -Math.sin(theta) })
  }
  return { z: [], p, k: 1 }
}

function lp2bp(z: C[], p: C[], k: number, wo: number, bw: number): { z: C[]; p: C[]; k: number } {
  const degree = p.length - z.length
  const halfBw = c(bw / 2)
  const wo2 = c(wo * wo)
  const scale = (x: C) => cmul(x, halfBw)
  const split = (x: C): [C, C] => {
    const disc = csqrt(csub(cmul(x, x), wo2))
    return [cadd(x, disc), csub(x, disc)]
  }
  const zBp: C[] = []
  const pBp: C[] = []
  for (const zi of z.map(scale)) zBp.push(...split(zi))
  for (const pi of p.map(scale)) pBp.push(...split(pi))
  for (let i = 0; i < degree; i++) zBp.push(ZERO)
  return { z: zBp, p: pBp, k: k * bw ** degree }
}

function bilinearZpk(z: C[], p: C[], k: number, fs: number): { z: C[]; p: C[]; k: number } {
  const fs2 = 2 * fs
  const twoFs = c(fs2)
  const map = (x: C) => cdiv(cadd(twoFs, x), csub(twoFs, x))
  const degree = p.length - z.length
  const zZ = z.map(map)
  const pZ = p.map(map)
  for (let i = 0; i < degree; i++) zZ.push(c(-1))
  const num = cprod(z.map((zi) => csub(twoFs, zi)))
  const den = cprod(p.map((pi) => csub(twoFs, pi)))
  const kZ = k * cdiv(num, den).re
  return { z: zZ, p: pZ, k: kZ }
}

function conjugatePairs(vals: C[]): C[][] {
  const leftover = vals.map((v) => ({ ...v }))
  const pairs: C[][] = []
  const used = leftover.map(() => false)
  for (let i = 0; i < leftover.length; i++) {
    if (used[i]) continue
    const a = leftover[i]!
    if (Math.abs(a.im) < 1e-12) {
      used[i] = true
      let mate = -1
      for (let j = i + 1; j < leftover.length; j++) {
        if (used[j]) continue
        if (Math.abs(leftover[j]!.im) < 1e-12) {
          mate = j
          break
        }
      }
      if (mate >= 0) {
        used[mate] = true
        pairs.push([a, leftover[mate]!])
      } else {
        pairs.push([a, a])
      }
      continue
    }
    let mate = -1
    let best = Infinity
    for (let j = i + 1; j < leftover.length; j++) {
      if (used[j]) continue
      const conjDist = Math.hypot(a.re - leftover[j]!.re, a.im + leftover[j]!.im)
      if (conjDist < best) {
        best = conjDist
        mate = j
      }
    }
    used[i] = true
    if (mate >= 0) used[mate] = true
    pairs.push(mate >= 0 ? [a, leftover[mate]!] : [a, { re: a.re, im: -a.im }])
  }
  return pairs
}

function biquad(z1: C, z2: C, p1: C, p2: C, gain: number): number[] {
  const zs = cadd(z1, z2)
  const zp = cmul(z1, z2)
  const ps = cadd(p1, p2)
  const pp = cmul(p1, p2)
  return [gain, -gain * zs.re, gain * zp.re, 1, -ps.re, pp.re]
}

/**
 * Pairing for digital Butterworth bandpass: Nyquist zeros with higher-frequency
 * poles, DC zeros with lower-frequency poles. Matches scipy zpk2sos for order 2.
 */
function zpk2sosButterBp(z: C[], p: C[], k: number): Sos {
  const polePairs = conjugatePairs(p).sort(
    (a, b) => Math.abs(carg(b[0]!)) - Math.abs(carg(a[0]!)),
  )
  const zeroPairs = conjugatePairs(z)
  const nyquist = zeroPairs.find((pair) => pair[0]!.re < 0) ?? [c(-1), c(-1)]
  const dc = zeroPairs.find((pair) => pair[0]!.re > 0) ?? [c(1), c(1)]
  const sos: Sos = []
  for (let i = 0; i < polePairs.length; i++) {
    const poles = polePairs[i]!
    const zeros = i === 0 ? nyquist : dc
    sos.push(biquad(zeros[0]!, zeros[1]!, poles[0]!, poles[1]!, i === 0 ? k : 1))
  }
  return sos
}

/**
 * Order-2 Butterworth bandpass, matching
 * `scipy.signal.butter(2, [low, high], btype='bandpass', fs, output='sos')`.
 */
export function designBandpassSos(lowHz: number, highHz: number, fs: number, order = 2): Sos {
  const nyq = fs * 0.49
  const lo = Math.max(0.05, Math.min(lowHz, nyq - 0.5))
  const hi = Math.max(lo + 0.5, Math.min(highHz, nyq))
  const analog = buttap(order)
  const wlow = 2 * fs * Math.tan((Math.PI * lo) / fs)
  const whigh = 2 * fs * Math.tan((Math.PI * hi) / fs)
  const wo = Math.sqrt(wlow * whigh)
  const bw = whigh - wlow
  const bp = lp2bp(analog.z, analog.p, analog.k, wo, bw)
  const digital = bilinearZpk(bp.z, bp.p, bp.k, fs)
  return zpk2sosButterBp(digital.z, digital.p, digital.k)
}

/**
 * scipy.signal.iirnotch(f0, Q, fs) as one SOS section.
 * gb=1/√2 ⇒ beta = tan((π f0 / fs) / Q).
 */
export function designNotchSos(f0: number, fs: number, Q = 30): Sos {
  const w0 = (2 * Math.PI * f0) / fs
  const beta = Math.tan(w0 / (2 * Math.max(1e-6, Q)))
  const gain = 1 / (1 + beta)
  const cosw = Math.cos(w0)
  const b0 = gain
  const b1 = -2 * gain * cosw
  const b2 = gain
  const a1 = -2 * gain * cosw
  const a2 = 2 * gain - 1
  return [[b0, b1, b2, 1, a1, a2]]
}

export function designNotchCascade(fs: number, mainsHz = 50): Sos {
  return [...designNotchSos(mainsHz, fs, 30), ...designNotchSos(mainsHz * 2, fs, 30)]
}

/** scipy.signal.sosfilt_zi — DF-II transposed, input=1. */
export function sosfiltZi(sos: Sos): Float64Array {
  const zi = new Float64Array(sos.length * 2)
  let scale = 1
  for (let s = 0; s < sos.length; s++) {
    const sec = sos[s]!
    const a0 = sec[3] || 1
    const b0 = sec[0]! / a0
    const b1 = sec[1]! / a0
    const b2 = sec[2]! / a0
    const a1 = sec[4]! / a0
    const a2 = sec[5]! / a0
    const yDc = (b0 + b1 + b2) / (1 + a1 + a2)
    const z0 = yDc - b0
    const z1 = b2 - a2 * yDc
    zi[s * 2] = z0 * scale
    zi[s * 2 + 1] = z1 * scale
    scale *= yDc
  }
  return zi
}
