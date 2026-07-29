import { mean, median, stddev } from '../../lib/rng'

export interface TrialResult {
  cardId: string
  round: number
  rtMs: number | null
  valid: boolean
  reason?: 'timeout' | 'miss' | 'ok'
}

export interface CardScore {
  cardId: string
  medianRt: number | null
  nValid: number
  nInvalid: number
  z: number | null
}

export interface DetectionResult {
  scores: CardScore[]
  guessId: string | null
  /** Chance level = 1/N */
  chance: number
}

/**
 * Per card: median of valid RTs → z-score within subject → highest z is the guess.
 */
export function detect(results: TrialResult[], cardIds: string[]): DetectionResult {
  const byCard = new Map<string, number[]>()
  const invalid = new Map<string, number>()
  for (const id of cardIds) {
    byCard.set(id, [])
    invalid.set(id, 0)
  }

  for (const r of results) {
    if (!byCard.has(r.cardId)) continue
    if (r.valid && r.rtMs !== null) {
      byCard.get(r.cardId)!.push(r.rtMs)
    } else {
      invalid.set(r.cardId, (invalid.get(r.cardId) ?? 0) + 1)
    }
  }

  const medians: { cardId: string; medianRt: number | null; nValid: number; nInvalid: number }[] =
    cardIds.map((id) => ({
      cardId: id,
      medianRt: median(byCard.get(id) ?? []),
      nValid: (byCard.get(id) ?? []).length,
      nInvalid: invalid.get(id) ?? 0,
    }))

  const validMedians = medians.map((m) => m.medianRt).filter((v): v is number => v !== null)
  const m = mean(validMedians)
  const s = stddev(validMedians)

  const scores: CardScore[] = medians.map((row) => ({
    ...row,
    z: row.medianRt === null || s === 0 ? null : (row.medianRt - m) / s,
  }))

  let guessId: string | null = null
  let bestZ = -Infinity
  for (const sc of scores) {
    if (sc.z !== null && sc.z > bestZ) {
      bestZ = sc.z
      guessId = sc.cardId
    }
  }

  return {
    scores,
    guessId,
    chance: cardIds.length > 0 ? 1 / cardIds.length : 0,
  }
}
