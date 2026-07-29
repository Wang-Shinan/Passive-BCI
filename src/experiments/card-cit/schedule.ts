import { mulberry32, shuffleInPlace } from '../../lib/rng'

export interface FlashTrial {
  round: number
  orderIndex: number
  cardId: string
  /** Planned ISI after this flash (ms). */
  isiMs: number
}

export interface ScheduleConfig {
  rounds?: number
  flashMs?: number
  isiMin?: number
  isiMax?: number
  deadlineMs?: number
  seed?: number
}

/**
 * Build a flash schedule: each round is a permutation of all cards,
 * with the constraint that the same card is never adjacent across round boundaries.
 */
export function buildSchedule(
  cardIds: string[],
  cfg: ScheduleConfig = {},
): FlashTrial[] {
  const rounds = cfg.rounds ?? 3
  const isiMin = cfg.isiMin ?? 600
  const isiMax = cfg.isiMax ?? 900
  const seed = cfg.seed ?? 1
  const rng = mulberry32(seed)

  const trials: FlashTrial[] = []
  let prevLast: string | null = null

  for (let r = 0; r < rounds; r++) {
    let order = shuffleInPlace([...cardIds], rng)
    let guard = 0
    while (prevLast !== null && order[0] === prevLast && guard < 40) {
      order = shuffleInPlace([...cardIds], rng)
      guard++
    }
    // Also avoid adjacent duplicates within (shouldn't happen with unique set)
    for (let i = 0; i < order.length; i++) {
      const isi = isiMin + rng() * (isiMax - isiMin)
      trials.push({
        round: r + 1,
        orderIndex: i,
        cardId: order[i]!,
        isiMs: Math.round(isi),
      })
    }
    prevLast = order[order.length - 1]!
  }

  return trials
}

export const DEFAULT_FLASH_MS = 300
export const DEFAULT_DEADLINE_MS = 1000
