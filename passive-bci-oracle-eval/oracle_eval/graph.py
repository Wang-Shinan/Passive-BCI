"""Seeded graph generation (free planar graph + grid), BFS distances."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class Graph:
    adj: List[List[int]]
    goal: int
    seed: int
    mode: str
    cols: Optional[int] = None
    rows: Optional[int] = None

    @property
    def n(self) -> int:
        return len(self.adj)


def mulberry32(seed: int):
    state = seed & 0xFFFFFFFF

    def rng() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = (t ^ (t >> 15)) & 0xFFFFFFFF
        t = (t * (1 | t)) & 0xFFFFFFFF
        t = (t ^ (t + ((t ^ (t >> 7)) * (61 | t)))) & 0xFFFFFFFF
        return float((t ^ (t >> 14)) / 4294967296.0)

    return rng


def bfs_dist(adj: Sequence[Sequence[int]], src: int, dst: int) -> int:
    if src == dst:
        return 0
    seen = {src}
    q = deque([(src, 0)])
    while q:
        u, d = q.popleft()
        for v in adj[u]:
            if v in seen:
                continue
            if v == dst:
                return d + 1
            seen.add(v)
            q.append((v, d + 1))
    return 10**9


def all_dist_to_goal(graph: Graph) -> np.ndarray:
    n = graph.n
    dist = np.full(n, 10**9, dtype=np.int32)
    dist[graph.goal] = 0
    q = deque([graph.goal])
    while q:
        u = q.popleft()
        for v in graph.adj[u]:
            if dist[v] > dist[u] + 1:
                dist[v] = dist[u] + 1
                q.append(v)
    return dist


def neighbors(graph: Graph, s: int) -> List[int]:
    return graph.adj[s]


def is_optimal_action(dist: np.ndarray, s: int, a: int) -> bool:
    """Action a from s is optimal iff it strictly decreases distance to goal."""
    return dist[a] < dist[s]


def generate_grid(cols: int = 6, rows: int = 5, seed: int = 1) -> Graph:
    rng = mulberry32(seed)
    n = cols * rows

    def idx(r: int, c: int) -> int:
        return r * cols + c

    adj: List[List[int]] = [[] for _ in range(n)]
    for r in range(rows):
        for c in range(cols):
            u = idx(r, c)
            if c + 1 < cols:
                v = idx(r, c + 1)
                adj[u].append(v)
                adj[v].append(u)
            if r + 1 < rows:
                v = idx(r + 1, c)
                adj[u].append(v)
                adj[v].append(u)

    corners = [idx(0, 0), idx(0, cols - 1), idx(rows - 1, 0), idx(rows - 1, cols - 1)]
    goal = corners[int(rng() * len(corners))]
    return Graph(adj=adj, goal=goal, seed=seed, mode="grid", cols=cols, rows=rows)


def generate_free_graph(node_count: int = 24, density: float = 1.8, seed: int = 1) -> Graph:
    """Lightweight connected geometric graph (for offline sims; no layout needed)."""
    rng = mulberry32(seed)
    # Place points in unit square
    pts = np.zeros((node_count, 2))
    for i in range(node_count):
        pts[i, 0] = rng()
        pts[i, 1] = rng()

    # Candidate edges by distance
    cand: List[Tuple[float, int, int]] = []
    for i in range(node_count):
        for j in range(i + 1, node_count):
            d = float(np.hypot(pts[i, 0] - pts[j, 0], pts[i, 1] - pts[j, 1]))
            cand.append((d, i, j))
    cand.sort()

    parent = list(range(node_count))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    edges: List[Tuple[int, int]] = []
    for d, i, j in cand:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
            edges.append((i, j))

    target = int(node_count * density)
    for d, i, j in cand:
        if len(edges) >= target:
            break
        if (i, j) in edges or (j, i) in edges:
            continue
        if d > 0.45:
            continue
        edges.append((i, j))

    adj: List[List[int]] = [[] for _ in range(node_count)]
    for i, j in edges:
        adj[i].append(j)
        adj[j].append(i)

    # Ensure min degree 2
    for i in range(node_count):
        while len(adj[i]) < 2:
            best, best_d = -1, 1e9
            for j in range(node_count):
                if i == j or j in adj[i]:
                    continue
                d = float(np.hypot(pts[i, 0] - pts[j, 0], pts[i, 1] - pts[j, 1]))
                if d < best_d:
                    best_d, best = d, j
            if best < 0:
                break
            adj[i].append(best)
            adj[best].append(i)

    # Goal: farthest BFS from a random node
    start_probe = int(rng() * node_count)
    dist = np.full(node_count, 10**9, dtype=np.int32)
    dist[start_probe] = 0
    q = deque([start_probe])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if dist[v] > dist[u] + 1:
                dist[v] = dist[u] + 1
                q.append(v)
    goal = int(np.argmax(dist))
    return Graph(adj=adj, goal=goal, seed=seed, mode="graph")


def pick_start(graph: Graph, dist: np.ndarray, rng: np.random.Generator, *, min_dist: int = 2) -> int:
    candidates = [i for i in range(graph.n) if i != graph.goal and dist[i] >= min_dist and dist[i] < 10**9]
    if not candidates:
        candidates = [i for i in range(graph.n) if i != graph.goal and dist[i] < 10**9]
    return int(candidates[int(rng.integers(0, len(candidates)))])
