import {
  createQTable,
  epsilonGreedy,
  getQ,
  setQ,
  type QTable,
} from './qlearning'

export type LearnAlgo = 'qlearning' | 'tamer' | 'ai'

export interface TamerParams {
  alpha: number
  epsilon: number
  /**
   * Credit-assignment window: how many recent steps share this feedback.
   * 1 = only the last action (most common when rating is per-step).
   */
  creditWindow: number
  /** Decay of credit toward older steps (0–1). weight_k ∝ decay^k */
  creditDecay: number
}

export interface TamerTraceStep {
  state: number
  action: number
}

/**
 * Classic tabular TAMER update (Knox & Stone):
 * treat human feedback as a supervised target for Ĥ(s,a), with no TD bootstrap.
 *
 *   Ĥ(s,a) ← Ĥ(s,a) + α · w · (f − Ĥ(s,a))
 *
 * Credit is optionally smeared over the last K (s,a) pairs (delay window).
 */
export function tamerUpdate(
  table: QTable,
  feedback: number,
  trace: readonly TamerTraceStep[],
  params: TamerParams,
): void {
  const window = Math.max(1, Math.floor(params.creditWindow))
  const decay = Math.min(1, Math.max(0, params.creditDecay))
  const recent = trace.slice(-window)
  if (recent.length === 0) return

  // Newest step is last; weight decays as we go older
  const weights: number[] = []
  let sum = 0
  for (let i = 0; i < recent.length; i++) {
    const age = recent.length - 1 - i // 0 = newest
    const w = decay ** age
    weights.push(w)
    sum += w
  }

  for (let i = 0; i < recent.length; i++) {
    const step = recent[i]!
    const w = weights[i]! / sum
    const old = getQ(table, step.state, step.action)
    const updated = old + params.alpha * w * (feedback - old)
    setQ(table, step.state, step.action, updated)
  }
}

export function createTamerTable(): QTable {
  return createQTable()
}

export { epsilonGreedy, getQ }

export function defaultTamerParams(): TamerParams {
  return {
    alpha: 0.5,
    epsilon: 0.15,
    creditWindow: 1,
    creditDecay: 0.5,
  }
}

export function algoLabel(algo: LearnAlgo): string {
  if (algo === 'tamer') return 'TAMER'
  if (algo === 'ai') return 'AI 分配 Q'
  return 'Q-learning'
}
