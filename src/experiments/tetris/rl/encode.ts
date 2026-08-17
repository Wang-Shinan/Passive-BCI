import { COLS, ROWS, type GameState, type PieceType } from '../engine'
import {
  PIECE_TYPES,
  RL_OBS_CHANNELS,
  RL_OBS_COLS,
  RL_OBS_ROWS,
  type RlModelMetadata,
} from './contracts'

export function pieceTypeIndex(type: PieceType): number {
  return PIECE_TYPES.indexOf(type)
}

/** Encode game state into channel-major float32 tensor [C, H, W]. */
export function encodeObservation(
  state: GameState,
  gravityNorm: number,
  out?: Float32Array,
): Float32Array {
  const size = RL_OBS_CHANNELS * RL_OBS_ROWS * RL_OBS_COLS
  const tensor = out ?? new Float32Array(size)
  tensor.fill(0)

  const stride = RL_OBS_ROWS * RL_OBS_COLS

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c
      const boardVal = state.board[r]![c]!
      if (boardVal > 0) tensor[idx] = boardVal / 7
    }
  }

  if (state.piece) {
    const piece = state.piece
    for (let r = 0; r < piece.matrix.length; r++) {
      for (let c = 0; c < piece.matrix[r]!.length; c++) {
        if (!piece.matrix[r]![c]) continue
        const x = piece.x + c
        const y = piece.y + r
        if (y < 0 || y >= ROWS || x < 0 || x >= COLS) continue
        const idx = y * COLS + x
        tensor[stride + idx] = 1
      }
    }

    const rotNorm = piece.rot / 3
    const fyNorm = Math.max(0, Math.min(1, piece.fy))
    const chRot = 2 * stride
    const chFy = 3 * stride
    for (let i = 0; i < stride; i++) {
      tensor[chRot + i] = rotNorm
      tensor[chFy + i] = fyNorm
    }
  }

  const nextIdx = pieceTypeIndex(state.next)
  if (nextIdx >= 0) {
    const ch = (4 + nextIdx) * stride
    for (let i = 0; i < stride; i++) tensor[ch + i] = 1
  }

  const g = Math.max(0, Math.min(1, gravityNorm))
  const chGravity = 11 * stride
  for (let i = 0; i < stride; i++) tensor[chGravity + i] = g

  return tensor
}

export function boardFingerprint(state: GameState): string {
  const parts: string[] = []
  for (let r = 0; r < ROWS; r++) {
    parts.push(state.board[r]!.join(''))
  }
  if (state.piece) {
    const p = state.piece
    parts.push(
      `P:${p.type},${p.rot},${p.x},${p.y},${p.fy.toFixed(3)}`,
    )
  } else {
    parts.push('P:null')
  }
  parts.push(`N:${state.next}`)
  parts.push(`S:${state.score},L:${state.lines},GO:${state.gameOver ? 1 : 0}`)
  return parts.join('|')
}

export function defaultMetadata(partial?: Partial<RlModelMetadata>): RlModelMetadata {
  return {
    version: 1,
    actionNames: [
      'noop',
      'left',
      'right',
      'rotateCW',
      'rotateCCW',
      'softDrop',
      'hardDrop',
    ],
    decisionIntervalMs: 100,
    obsChannels: RL_OBS_CHANNELS,
    obsRows: RL_OBS_ROWS,
    obsCols: RL_OBS_COLS,
    gravityMin: 1,
    gravityMax: 6,
    ...partial,
  }
}

export function normalizeGravity(cellsPerSec: number, meta: RlModelMetadata): number {
  const span = Math.max(1e-6, meta.gravityMax - meta.gravityMin)
  return Math.max(0, Math.min(1, (cellsPerSec - meta.gravityMin) / span))
}
