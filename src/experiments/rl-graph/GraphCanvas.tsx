import { useMemo } from 'react'
import type { Graph } from './graph'
import { edgeKey } from './graph'
import type { QTable } from './qlearning'
import { bestAction, edgeQ } from './qlearning'

function qColor(q: number, qMin: number, qMax: number): string {
  if (qMax === qMin) return '#4a5678'
  const t = Math.max(0, Math.min(1, (q - qMin) / (qMax - qMin)))
  const r = Math.round(t < 0.5 ? 40 + t * 80 : 80 + (t - 0.5) * 350)
  const g = Math.round(80 + t * 160)
  const b = Math.round(t < 0.5 ? 200 - t * 80 : 160 - (t - 0.5) * 280)
  return `rgb(${r},${g},${b})`
}

export function GraphCanvas({
  graph,
  qTable,
  agentPos,
  episodeStart,
  animFrom,
  animTo,
  animT,
  width = 720,
  height = 480,
}: {
  graph: Graph
  qTable: QTable
  agentPos: number
  /** Current episode spawn node (not a fixed map property). */
  episodeStart: number
  animFrom: number | null
  animTo: number | null
  animT: number
  width?: number
  height?: number
}) {
  const nodeR = graph.nodes.length > 30 ? 10 : graph.nodes.length > 20 ? 12 : 14
  const fontSize = nodeR >= 14 ? 11 : 9

  const { qMin, qMax, edgeQs } = useMemo(() => {
    const map = new Map<string, number>()
    let min = Infinity
    let max = -Infinity
    for (const e of graph.edges) {
      const q = edgeQ(qTable, e.from, e.to)
      map.set(edgeKey(e.from, e.to), q)
      min = Math.min(min, q)
      max = Math.max(max, q)
    }
    if (!Number.isFinite(min)) {
      min = 0
      max = 0
    }
    return { qMin: min, qMax: max, edgeQs: map }
  }, [graph, qTable])

  const agentXY = useMemo(() => {
    if (animFrom !== null && animTo !== null) {
      const a = graph.nodes[animFrom]!
      const b = graph.nodes[animTo]!
      return {
        x: a.x + (b.x - a.x) * animT,
        y: a.y + (b.y - a.y) * animT,
      }
    }
    const n = graph.nodes[agentPos]!
    return { x: n.x, y: n.y }
  }, [graph, agentPos, animFrom, animTo, animT])

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="100%"
      className="rounded-xl bg-[#0d1424]"
      role="img"
      aria-label="节点网络"
    >
      {graph.edges.map((e) => {
        const a = graph.nodes[e.from]!
        const b = graph.nodes[e.to]!
        const q = edgeQs.get(edgeKey(e.from, e.to)) ?? 0
        const t = qMax === qMin ? 0.3 : (q - qMin) / (qMax - qMin || 1)
        const strokeW = 1.2 + t * 4
        return (
          <line
            key={edgeKey(e.from, e.to)}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={qColor(q, qMin, qMax)}
            strokeWidth={strokeW}
            strokeLinecap="round"
            opacity={0.85}
          />
        )
      })}

      {graph.nodes.map((n) => {
        const best = bestAction(qTable, graph, n.id)
        if (best === null) return null
        const target = graph.nodes[best]!
        const dx = target.x - n.x
        const dy = target.y - n.y
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len
        const uy = dy / len
        const startR = nodeR + 2
        const endR = nodeR + 8
        const x1 = n.x + ux * startR
        const y1 = n.y + uy * startR
        const x2 = n.x + ux * (len - endR)
        const y2 = n.y + uy * (len - endR)
        return (
          <g key={`arrow-${n.id}`}>
            <defs>
              <marker
                id={`m-${n.id}`}
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 Z" fill="#e8eefc" opacity="0.55" />
              </marker>
            </defs>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#e8eefc"
              strokeWidth={1.2}
              opacity={0.35}
              markerEnd={`url(#m-${n.id})`}
            />
          </g>
        )
      })}

      {graph.nodes.map((n) => {
        const isSpawn = n.id === episodeStart
        const isGoal = n.id === graph.goal
        const fill = isGoal ? '#38d39f' : isSpawn ? '#5b8cff' : '#1c2740'
        const stroke = isGoal ? '#7aefc0' : isSpawn ? '#8eb0ff' : '#4a5678'
        return (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={nodeR} fill={fill} stroke={stroke} strokeWidth={2} />
            <text
              x={n.x}
              y={n.y + 1}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#e8eefc"
              fontSize={fontSize}
              fontFamily="monospace"
            >
              {n.id}
            </text>
            {isSpawn && !isGoal && (
              <text x={n.x} y={n.y - nodeR - 8} textAnchor="middle" fill="#8eb0ff" fontSize={10}>
                本局起点
              </text>
            )}
            {isGoal && (
              <text x={n.x} y={n.y - nodeR - 8} textAnchor="middle" fill="#7aefc0" fontSize={10}>
                终点
              </text>
            )}
          </g>
        )
      })}

      <g>
        <circle
          cx={agentXY.x}
          cy={agentXY.y}
          r={Math.max(8, nodeR - 2)}
          fill="#f5a524"
          stroke="#ffe0a0"
          strokeWidth={2}
          filter="drop-shadow(0 0 6px rgba(245,165,36,0.6))"
        />
        <circle cx={agentXY.x} cy={agentXY.y} r={3} fill="#fff" />
      </g>
    </svg>
  )
}
