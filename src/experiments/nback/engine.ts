export const LETTERS = ['A', 'B', 'C', 'D', 'F', 'H', 'K', 'M', 'R'] as const
export type Trial = { letter: string; target: boolean; scored: boolean }
export type Result = Trial & { index: number; rtMs: number | null; outcome: 'warmup' | 'hit' | 'miss' | 'false_alarm' | 'correct_rejection' }

export function generateTrials(n: number, count: number, seed: number): Trial[] {
  if (!Number.isInteger(n) || n < 1 || n > 3 || !Number.isInteger(count) || count < 1) {
    throw new Error('Invalid N-back configuration')
  }
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  const positions = Array.from({ length: count }, (_, i) => i + n)
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[positions[i], positions[j]] = [positions[j]!, positions[i]!]
  }
  const targets = new Set(positions.slice(0, Math.round(count * 0.3)))
  const trials: Trial[] = []
  for (let i = 0; i < count + n; i++) {
    const target = targets.has(i)
    const previous = i >= n ? trials[i - n]!.letter : null
    const choices = LETTERS.filter((letter) => letter !== previous)
    const letter = target ? previous! : choices[Math.floor(random() * choices.length)]!
    trials.push({ letter, target, scored: i >= n })
  }
  return trials
}

export function scoreTrial(trial: Trial, index: number, rtMs: number | null): Result {
  const outcome = !trial.scored ? 'warmup' : trial.target
    ? rtMs === null ? 'miss' : 'hit'
    : rtMs === null ? 'correct_rejection' : 'false_alarm'
  return { ...trial, index, rtMs, outcome }
}

export function summarize(results: Result[]) {
  const scored = results.filter((r) => r.scored)
  const hits = scored.filter((r) => r.outcome === 'hit')
  const misses = scored.filter((r) => r.outcome === 'miss').length
  const falseAlarms = scored.filter((r) => r.outcome === 'false_alarm').length
  const correctRejections = scored.filter((r) => r.outcome === 'correct_rejection').length
  return {
    total: scored.length, hits: hits.length, misses, falseAlarms, correctRejections,
    accuracy: scored.length ? (hits.length + correctRejections) / scored.length : null,
    meanHitRtMs: hits.length ? hits.reduce((sum, r) => sum + r.rtMs!, 0) / hits.length : null,
  }
}
