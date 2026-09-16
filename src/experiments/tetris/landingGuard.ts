import { ghostY, move, type GameState } from './engine'
import { boardFeatures } from './boardFeatures'
import { simulateLock } from './rl/heuristic'

/** Protect a useful landing only in the final two cells of descent. */
export function harmsUsefulLanding(state: GameState, direction: 'left' | 'right'): boolean {
  if (!state.piece || state.gameOver || state.paused || state.anim) return false
  if (ghostY(state.board, state.piece) - state.piece.y > 2) return false
  const moved = move(state, direction === 'left' ? -1 : 1, () => .5).state
  if (!moved.piece || moved.piece.x === state.piece.x) return false
  const stay = simulateLock(state), away = simulateLock(moved)
  const holes = boardFeatures(stay.board).holes
  const useful = stay.lines > state.lines || holes < boardFeatures(state.board).holes
  return useful && (away.gameOver || away.lines < stay.lines || boardFeatures(away.board).holes > holes)
}

export class LandingIntentGuard {
  private pending: { key: string; direction: string; since: number; last: number; count: number } | null = null
  reset() { this.pending = null }
  allow(key: string, direction: string, now: number, strong: boolean): boolean {
    if (!strong) { this.reset(); return false }
    const p = this.pending
    if (!p || p.key !== key || p.direction !== direction || now - p.last > 350) {
      this.pending = { key, direction, since: now, last: now, count: 1 }
      return false
    }
    p.last = now; p.count++
    return p.count >= 3 && now - p.since >= 400
  }
}
