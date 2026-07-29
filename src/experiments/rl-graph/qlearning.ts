import type { Graph } from './graph'
import { neighbors } from './graph'

export interface QParams {
  alpha: number
  gamma: number
  epsilon: number
  stepPenalty: number
  goalReward: number
}

export interface QTable {
  /** q[state][action] where action is neighbor node id */
  values: Map<string, number>
}

function key(state: number, action: number): string {
  return `${state}->${action}`
}

export function createQTable(): QTable {
  return { values: new Map() }
}

export function getQ(table: QTable, state: number, action: number): number {
  return table.values.get(key(state, action)) ?? 0
}

export function setQ(table: QTable, state: number, action: number, value: number): void {
  table.values.set(key(state, action), value)
}

export function maxQ(table: QTable, graph: Graph, state: number): number {
  const acts = neighbors(graph, state)
  if (acts.length === 0) return 0
  let best = -Infinity
  for (const a of acts) {
    best = Math.max(best, getQ(table, state, a))
  }
  return best === -Infinity ? 0 : best
}

export function bestAction(
  table: QTable,
  graph: Graph,
  state: number,
  rng: () => number = Math.random,
): number | null {
  const acts = neighbors(graph, state)
  if (acts.length === 0) return null
  let bestVal = -Infinity
  const bestActs: number[] = []
  for (const a of acts) {
    const q = getQ(table, state, a)
    if (q > bestVal) {
      bestVal = q
      bestActs.length = 0
      bestActs.push(a)
    } else if (q === bestVal) {
      bestActs.push(a)
    }
  }
  return bestActs[Math.floor(rng() * bestActs.length)]!
}

export function epsilonGreedy(
  table: QTable,
  graph: Graph,
  state: number,
  epsilon: number,
  rng: () => number = Math.random,
): number | null {
  const acts = neighbors(graph, state)
  if (acts.length === 0) return null
  if (rng() < epsilon) {
    return acts[Math.floor(rng() * acts.length)]!
  }
  return bestAction(table, graph, state, rng)
}

/**
 * TD update: Q(s,a) ← Q(s,a) + α [r_human + r_env + γ max Q(s',·) − Q(s,a)]
 */
export function tdUpdate(
  table: QTable,
  graph: Graph,
  state: number,
  action: number,
  nextState: number,
  humanReward: number,
  params: QParams,
  done: boolean,
): number {
  const envReward = done ? params.goalReward : params.stepPenalty
  const totalR = humanReward + envReward
  const old = getQ(table, state, action)
  const bootstrap = done ? 0 : maxQ(table, graph, nextState)
  const target = totalR + params.gamma * bootstrap
  const updated = old + params.alpha * (target - old)
  setQ(table, state, action, updated)
  return updated
}

/** Aggregate Q for undirected edge visualization (max of both directions). */
export function edgeQ(table: QTable, a: number, b: number): number {
  return Math.max(getQ(table, a, b), getQ(table, b, a))
}
