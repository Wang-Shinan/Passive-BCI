import { describe, expect, it } from 'vitest'
import { DIRECTIONS, marker, slideEnd, validateLevel, type Point } from './engine'
import { LEVELS } from './levels'

const key = (p: Point) => `${p.x},${p.y}`
describe('all published levels use slide reachability, not walking connectivity', () => {
  for (const [index, level] of LEVELS.entries()) it(`${level.difficulty}: reachable goal and recoverable stopping states`, () => {
    validateLevel(level)
    const start = marker(level, 'S'), goal = marker(level, 'G')
    const queue = [start], distance = new Map([[key(start), 0]])
    const reverse = new Map<string, Set<string>>()
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i]!
      for (const direction of DIRECTIONS) {
        const end = slideEnd(level, p, direction)
        const predecessors = reverse.get(key(end)) ?? new Set<string>()
        predecessors.add(key(p)); reverse.set(key(end), predecessors)
        if (!distance.has(key(end))) { distance.set(key(end), distance.get(key(p))! + 1); queue.push(end) }
      }
    }
    expect(distance.get(key(goal))).toBe([5, 9, 13][index])
    const recoverable = new Set([key(goal)]), pending = [key(goal)]
    for (let i = 0; i < pending.length; i++) {
      for (const p of reverse.get(pending[i]!) ?? []) if (!recoverable.has(p)) { recoverable.add(p); pending.push(p) }
    }
    expect(recoverable.size).toBe(distance.size)
    expect([...reverse.get(key(goal)) ?? []].some(p => p !== key(goal))).toBe(true)
  })
})
