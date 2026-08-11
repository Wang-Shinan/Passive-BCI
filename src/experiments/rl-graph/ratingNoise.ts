import { clamp } from '../../lib/rng'

/**
 * Add Gaussian noise and clamp to rating range — simulates noisy EEG decoding.
 */
export function corruptRating(
  clean: number,
  sigma: number,
  rng: () => number = Math.random,
): number {
  if (sigma <= 0) return clamp(clean, -1, 1)
  // Box–Muller
  const u = Math.max(1e-12, rng())
  const v = rng()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return clamp(clean + z * sigma, -1, 1)
}

export const RATING_LEVELS = [-1, -0.5, 0, 0.5, 1] as const

/** Optional discrete flip: with probability p, snap to a random other rating level. */
export function maybeFlipRating(
  clean: number,
  flipProb: number,
  rng: () => number = Math.random,
): number {
  if (flipProb <= 0 || rng() >= flipProb) return clean
  const others = RATING_LEVELS.filter((x) => x !== clean)
  return others[Math.floor(rng() * others.length)] ?? clean
}

/** Uniform draw from discrete rating levels — chance-level decoder baseline. */
export function randomRating(rng: () => number = Math.random): number {
  return RATING_LEVELS[Math.floor(rng() * RATING_LEVELS.length)] ?? 0
}
