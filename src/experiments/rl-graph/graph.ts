import { mulberry32 } from '../../lib/rng'

export type GraphMode = 'graph' | 'grid'

export interface GraphNode {
  id: number
  x: number
  y: number
  /** Grid coords when mode === 'grid' */
  row?: number
  col?: number
}

export interface GraphEdge {
  from: number
  to: number
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Adjacency list: nodeId → neighbor ids */
  adj: number[][]
  /** Fixed goal; episode starts are sampled separately. */
  goal: number
  seed: number
  mode: GraphMode
  /** Grid size when applicable */
  cols?: number
  rows?: number
}

export interface GraphParams {
  mode?: GraphMode
  /** Graph mode: number of nodes. Grid mode: ignored (use cols/rows). */
  nodeCount?: number
  cols?: number
  rows?: number
  seed?: number
  width?: number
  height?: number
  minDegree?: number
  /** Edge density multiplier for graph mode (1 = default, higher = denser). */
  density?: number
}

export interface StartPickOptions {
  /** Only spawn on degree-1 leaf nodes (undirected analogue of in-degree-0 sources). */
  leafOnly?: boolean
  /** Exclude the goal node (always recommended). */
  excludeGoal?: boolean
}

function dist(a: GraphNode, b: GraphNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function hasEdge(edges: GraphEdge[], a: number, b: number): boolean {
  return edges.some(
    (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a),
  )
}

function buildAdj(n: number, edges: GraphEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    adj[e.from]!.push(e.to)
    adj[e.to]!.push(e.from)
  }
  return adj
}

function isConnected(n: number, adj: number[][]): boolean {
  const seen = new Set<number>([0])
  const stack = [0]
  while (stack.length) {
    const u = stack.pop()!
    for (const v of adj[u]!) {
      if (!seen.has(v)) {
        seen.add(v)
        stack.push(v)
      }
    }
  }
  return seen.size === n
}

function shortestPath(adj: number[][], start: number, goal: number): number {
  if (start === goal) return 0
  const distMap = new Map<number, number>([[start, 0]])
  const q = [start]
  while (q.length) {
    const u = q.shift()!
    for (const v of adj[u]!) {
      if (!distMap.has(v)) {
        distMap.set(v, distMap.get(u)! + 1)
        if (v === goal) return distMap.get(v)!
        q.push(v)
      }
    }
  }
  return Infinity
}

function pickGoalFarFromCenter(
  nodes: GraphNode[],
  adj: number[][],
  rng: () => number,
): number {
  const n = nodes.length
  let cx = 0
  let cy = 0
  for (const node of nodes) {
    cx += node.x
    cy += node.y
  }
  cx /= n
  cy /= n

  // Prefer peripheral nodes as goal
  const ranked = nodes
    .map((node) => ({
      id: node.id,
      d: Math.hypot(node.x - cx, node.y - cy),
      deg: adj[node.id]!.length,
    }))
    .sort((a, b) => b.d - a.d)

  const candidates = ranked.slice(0, Math.max(3, Math.floor(n * 0.25)))
  return candidates[Math.floor(rng() * candidates.length)]!.id
}

function generateFreeGraph(params: GraphParams): Graph {
  const nodeCount = params.nodeCount ?? 24
  const seed = params.seed ?? (Math.random() * 0xffffffff) >>> 0
  const width = params.width ?? 720
  const height = params.height ?? 480
  const minDegree = params.minDegree ?? 2
  const density = params.density ?? 1.8
  const rng = mulberry32(seed)

  const margin = 36
  const nodes: GraphNode[] = []

  // Denser packing: smaller separation
  const minSep = Math.min(width, height) / (Math.sqrt(nodeCount) * 2.4)
  let attempts = 0
  while (nodes.length < nodeCount && attempts < nodeCount * 400) {
    attempts++
    const x = margin + rng() * (width - 2 * margin)
    const y = margin + rng() * (height - 2 * margin)
    if (nodes.every((n) => Math.hypot(n.x - x, n.y - y) >= minSep * 0.7)) {
      nodes.push({ id: nodes.length, x, y })
    }
  }
  while (nodes.length < nodeCount) {
    nodes.push({
      id: nodes.length,
      x: margin + rng() * (width - 2 * margin),
      y: margin + rng() * (height - 2 * margin),
    })
  }

  const candidates: { a: number; b: number; d: number }[] = []
  for (let i = 0; i < nodeCount; i++) {
    for (let j = i + 1; j < nodeCount; j++) {
      candidates.push({ a: i, b: j, d: dist(nodes[i]!, nodes[j]!) })
    }
  }
  candidates.sort((u, v) => u.d - v.d)

  const edges: GraphEdge[] = []
  const parent = Array.from({ length: nodeCount }, (_, i) => i)
  const find = (x: number): number => {
    if (parent[x] !== x) parent[x] = find(parent[x]!)
    return parent[x]!
  }
  for (const c of candidates) {
    const ra = find(c.a)
    const rb = find(c.b)
    if (ra !== rb) {
      parent[ra] = rb
      edges.push({ from: c.a, to: c.b })
    }
  }

  const targetEdges = Math.floor(nodeCount * density)
  for (const c of candidates) {
    if (edges.length >= targetEdges) break
    if (hasEdge(edges, c.a, c.b)) continue
    if (c.d > minSep * 3.8) continue
    edges.push({ from: c.a, to: c.b })
  }

  let adj = buildAdj(nodeCount, edges)
  for (let i = 0; i < nodeCount; i++) {
    while (adj[i]!.length < minDegree) {
      let best = -1
      let bestD = Infinity
      for (let j = 0; j < nodeCount; j++) {
        if (i === j || hasEdge(edges, i, j)) continue
        const d = dist(nodes[i]!, nodes[j]!)
        if (d < bestD) {
          bestD = d
          best = j
        }
      }
      if (best < 0) break
      edges.push({ from: i, to: best })
      adj = buildAdj(nodeCount, edges)
    }
  }

  if (!isConnected(nodeCount, adj)) {
    return generateFreeGraph({ ...params, seed: seed + 1 })
  }

  const goal = pickGoalFarFromCenter(nodes, adj, rng)
  return { nodes, edges, adj, goal, seed, mode: 'graph' }
}

function generateGridGraph(params: GraphParams): Graph {
  const cols = params.cols ?? 6
  const rows = params.rows ?? 5
  const seed = params.seed ?? (Math.random() * 0xffffffff) >>> 0
  const width = params.width ?? 720
  const height = params.height ?? 480
  const rng = mulberry32(seed)

  const marginX = 48
  const marginY = 40
  const cellW = (width - 2 * marginX) / Math.max(1, cols - 1)
  const cellH = (height - 2 * marginY) / Math.max(1, rows - 1)

  const nodes: GraphNode[] = []
  const idAt = (r: number, c: number) => r * cols + c

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push({
        id: idAt(r, c),
        x: marginX + c * cellW,
        y: marginY + r * cellH,
        row: r,
        col: c,
      })
    }
  }

  const edges: GraphEdge[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = idAt(r, c)
      if (c + 1 < cols) edges.push({ from: id, to: idAt(r, c + 1) })
      if (r + 1 < rows) edges.push({ from: id, to: idAt(r + 1, c) })
    }
  }

  const adj = buildAdj(nodes.length, edges)

  // Goal: prefer a corner opposite a random corner start region
  const corners = [
    idAt(0, 0),
    idAt(0, cols - 1),
    idAt(rows - 1, 0),
    idAt(rows - 1, cols - 1),
  ]
  const goal = corners[Math.floor(rng() * corners.length)]!

  return {
    nodes,
    edges,
    adj,
    goal,
    seed,
    mode: 'grid',
    cols,
    rows,
  }
}

/**
 * Generate a connected node network (free graph or rectangular grid).
 * Goal is fixed; episode starts should be sampled via pickRandomStart.
 */
export function generateGraph(params: GraphParams = {}): Graph {
  const mode = params.mode ?? 'graph'
  if (mode === 'grid') return generateGridGraph(params)
  return generateFreeGraph(params)
}

export function degreeOf(graph: Graph, nodeId: number): number {
  return graph.adj[nodeId]?.length ?? 0
}

/** Candidate starts: non-goal nodes, optionally only leaves (deg === 1). */
export function startCandidates(graph: Graph, opts: StartPickOptions = {}): number[] {
  const excludeGoal = opts.excludeGoal !== false
  const leafOnly = opts.leafOnly === true
  return graph.nodes
    .map((n) => n.id)
    .filter((id) => {
      if (excludeGoal && id === graph.goal) return false
      if (leafOnly && degreeOf(graph, id) !== 1) return false
      return true
    })
}

export function pickRandomStart(
  graph: Graph,
  rng: () => number = Math.random,
  opts: StartPickOptions = {},
): number {
  let pool = startCandidates(graph, opts)
  if (pool.length === 0) {
    // Fallback: any non-goal, then any node
    pool = startCandidates(graph, { ...opts, leafOnly: false })
  }
  if (pool.length === 0) {
    pool = graph.nodes.map((n) => n.id).filter((id) => id !== graph.goal)
  }
  if (pool.length === 0) return graph.goal
  return pool[Math.floor(rng() * pool.length)]!
}

export function neighbors(graph: Graph, nodeId: number): number[] {
  return graph.adj[nodeId] ?? []
}

export function bfsDistance(graph: Graph, from: number, to: number): number {
  return shortestPath(graph.adj, from, to)
}

/** Edge key independent of direction. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

/** How many leaf nodes (deg=1) exist — for UI hint. */
export function countLeaves(graph: Graph): number {
  return graph.nodes.filter((n) => degreeOf(graph, n.id) === 1 && n.id !== graph.goal).length
}
