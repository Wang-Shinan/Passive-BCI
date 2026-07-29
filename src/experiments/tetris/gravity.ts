import { clamp } from '../../lib/rng'

export type GravityMode = 'challenge' | 'regulate'

export interface GravityConfig {
  mode: GravityMode
  /** Challenge: stress→gravity curve */
  minGravity: number
  maxGravity: number
  /** Regulate: PI setpoint */
  setpoint: number
  kp: number
  ki: number
  /** EMA smoothing on gravity output */
  smooth: number
}

export interface GravityState {
  gravity: number
  integral: number
  smoothed: number
}

export function defaultGravityConfig(): GravityConfig {
  return {
    mode: 'regulate',
    minGravity: 0.4,
    maxGravity: 8,
    setpoint: 50,
    kp: 0.04,
    ki: 0.005,
    smooth: 0.15,
  }
}

export function initGravityState(cfg: GravityConfig): GravityState {
  const mid = (cfg.minGravity + cfg.maxGravity) / 2
  return { gravity: mid, integral: 0, smoothed: mid }
}

/** Challenge: higher stress → faster fall (exponential-ish). */
function challengeGravity(stress: number, cfg: GravityConfig): number {
  const t = clamp(stress / 100, 0, 1)
  const curved = t * t
  return cfg.minGravity + curved * (cfg.maxGravity - cfg.minGravity)
}

/**
 * Regulate: PI controller keeps stress near setpoint.
 * stress > setpoint → decrease gravity; stress < setpoint → increase.
 */
function regulateGravity(
  stress: number,
  cfg: GravityConfig,
  state: GravityState,
  dtSec: number,
): { gravity: number; integral: number } {
  const error = cfg.setpoint - stress // positive when stress too low → speed up
  const integral = clamp(state.integral + error * dtSec, -200, 200)
  const raw = state.gravity + cfg.kp * error + cfg.ki * integral
  return {
    gravity: clamp(raw, cfg.minGravity, cfg.maxGravity),
    integral,
  }
}

export function updateGravity(
  stress: number,
  cfg: GravityConfig,
  state: GravityState,
  dtSec: number,
): GravityState {
  let gravity: number
  let integral = state.integral

  if (cfg.mode === 'challenge') {
    gravity = challengeGravity(stress, cfg)
  } else {
    const r = regulateGravity(stress, cfg, state, dtSec)
    gravity = r.gravity
    integral = r.integral
  }

  const smoothed = state.smoothed + cfg.smooth * (gravity - state.smoothed)
  return { gravity, integral, smoothed }
}

/** Convert cells/sec gravity to ms per cell drop. */
export function gravityToIntervalMs(gravity: number): number {
  return 1000 / Math.max(0.05, gravity)
}
