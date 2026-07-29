/** Mulberry32 seeded PRNG for reproducible experiments. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0
}

export function shuffleInPlace<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export function choice<T>(arr: readonly T[], rng: () => number = Math.random): T {
  return arr[Math.floor(rng() * arr.length)]!
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]!
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const v = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(v)
}
