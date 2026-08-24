import { BOARD_DEFAULT_CELL } from '../tetris/Board'
import { AdaptBoard } from './AdaptBoard'
import type { MiniState } from './miniBoard'

/** Cropped well: same cell px as the default 10×20 `/tetris` Board, fewer columns. */
export function MiniBoardView({
  state,
  cell = BOARD_DEFAULT_CELL,
  overlay,
  flash,
}: {
  state: MiniState | null
  cell?: number
  overlay?: string | null
  flash?: 'hit' | 'miss' | null
}) {
  return <AdaptBoard mini={state} cell={cell} overlay={overlay} flash={flash} />
}
