import type { PieceType } from '../engine'

/** Fixed decision interval for RL agent (ms). */
export const RL_DECISION_INTERVAL_MS = 100

/** Decision interval as seconds (gravity integration step). */
export const RL_DECISION_DT_SEC = RL_DECISION_INTERVAL_MS / 1000

/** ONNX / training input tensor shape: [channels, rows, cols]. */
export const RL_OBS_CHANNELS = 12
export const RL_OBS_ROWS = 20
export const RL_OBS_COLS = 10

export const RL_MODEL_VERSION = 1

export const RL_ACTION_NAMES = [
  'noop',
  'left',
  'right',
  'rotateCW',
  'rotateCCW',
  'softDrop',
  'hardDrop',
] as const

export type RlAction = (typeof RL_ACTION_NAMES)[number]

export const RL_ACTION_COUNT = RL_ACTION_NAMES.length

export const PIECE_TYPES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

export const RL_SOFT_DROP_CELLS_PER_SEC = 22

export interface RlModelMetadata {
  version: number
  actionNames: readonly string[]
  decisionIntervalMs: number
  obsChannels: number
  obsRows: number
  obsCols: number
  gravityMin: number
  gravityMax: number
  trainedSteps?: number
  evalMeanLines?: number
  exportedAt?: string
}

export const DEFAULT_RL_MODEL_PATH = '/models/tetris-rl/tetris-dqn.onnx'
export const DEFAULT_RL_METADATA_PATH = '/models/tetris-rl/metadata.json'
