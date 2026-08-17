import { advanceBoardAnim, type GameEvent, type GameState, type StepResult } from '../engine'

/**
 * Instantly resolve board clear/fall animations (training / parity mode).
 * Does not change human-facing animation timing when unused.
 */
export function instantResolveAnim(state: GameState, rng: () => number): StepResult {
  let current = state
  const events: GameEvent[] = []
  let guard = 0

  while (current.anim && guard < 64) {
    guard++
    const remaining = Math.max(1, current.anim.duration - current.anim.elapsed)
    const result = advanceBoardAnim(current, rng, remaining)
    current = result.state
    events.push(...result.events)
  }

  return { state: current, events }
}
