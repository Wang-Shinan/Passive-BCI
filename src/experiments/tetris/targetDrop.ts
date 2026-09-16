import { collides, type GameState } from './engine'
import { bestPlacement, type PlacementChoice } from './rl/heuristic'

export function tapSoftDrop(state: GameState): GameState {
  if (!state.piece || state.paused || state.gameOver || state.anim || collides(state.board, state.piece, 0, 1)) return state
  return { ...state, piece: { ...state.piece, y: state.piece.y + 1 }, score: state.score + 1, lockTimer: 0 }
}

export function matchesTeacherTarget(state: GameState, target: PlacementChoice | null): boolean {
  return Boolean(state.piece && !state.paused && !state.gameOver && !state.anim && target
    && state.piece.x === target.x && state.piece.rot === target.rot)
}

/** Recompute only when the board or piece geometry changes, not every animation frame. */
export class TeacherTargetDrop {
  private board: GameState['board'] | null = null
  private key = ''
  private target: PlacementChoice | null = null
  private checkedAt = -Infinity
  ready(state: GameState): boolean {
    const p = state.piece
    if (!p || state.paused || state.gameOver || state.anim) return false
    const key = `${p.type}|${p.x}|${p.rot}`
    if (this.board !== state.board || this.key !== key) {
      // Never use a stale target while waiting for the next search slot.
      const now = performance.now()
      if (now - this.checkedAt < 200) return false
      this.checkedAt = now
      this.board = state.board; this.key = key; this.target = bestPlacement(state)
    }
    return matchesTeacherTarget(state, this.target)
  }
}
