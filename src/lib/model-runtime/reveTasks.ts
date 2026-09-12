export type ReveTaskId = 'passive_rating' | 'smr_control' | 'tetris_action'

export const REVE_WINDOW_SEC = 2
export const REVE_DEFAULT_LIVE_STEP_SEC = 0.5
/** Keep using the last REVE prediction through a GPU/WS hitch. */
export const LIVE_PREDICTION_MAX_AGE_MS = 8000
/** Tetris pages + tetris_action live decode hop. Offline export/fit must not reuse this. */
export const TETRIS_LIVE_STEP_SEC = 0.1

export type ReveTaskOption = {
  id: ReveTaskId
  label: string
  short: string
  semantics: string
  classNames: readonly string[]
}

export const REVE_TASKS: readonly ReveTaskOption[] = [
  {
    id: 'passive_rating',
    label: '三类 · 任务一 / 任务二 / 任务三',
    short: '三类头',
    semantics: 'ordinal_rating_3',
    classNames: ['任务一', '任务二', '任务三'],
  },
  {
    id: 'smr_control',
    label: 'SMR · 左 / 右 / 双手 / 休息',
    short: 'SMR 头',
    semantics: 'smr_control_4',
    classNames: ['left_hand', 'right_hand', 'both_hand', 'rest'],
  },
  {
    id: 'tetris_action',
    label: '方块 · 7 类操作',
    short: '操作头',
    semantics: 'tetris_action_7',
    classNames: ['rest', 'left', 'right', 'rotateCW', 'rotateCCW', 'softDrop', 'hardDrop'],
  },
]

const ONLINE_LEARN_TASK_KEY = 'passive-bci.online-learn-task'

export function isReveTaskId(value: string | null | undefined): value is ReveTaskId {
  return REVE_TASKS.some((item) => item.id === value)
}

export function reveTaskOption(id: string | null | undefined): ReveTaskOption | undefined {
  return REVE_TASKS.find((item) => item.id === id)
}

export function loadOnlineLearnTask(): ReveTaskId {
  if (typeof window === 'undefined') return 'passive_rating'
  const stored = window.localStorage.getItem(ONLINE_LEARN_TASK_KEY)
  return isReveTaskId(stored) ? stored : 'passive_rating'
}

export function saveOnlineLearnTask(id: ReveTaskId): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ONLINE_LEARN_TASK_KEY, id)
}

export function rewardForClass(semantics: string | undefined, classId: number): number | undefined {
  if (semantics !== 'ordinal_rating_3') return undefined
  if (classId === 0) return -1
  if (classId === 2) return 1
  return 0
}

export function defaultReveStrategy(task: string | null | undefined): 'none' | 'supervised-head' {
  return task === 'smr_control' ? 'none' : 'supervised-head'
}

export function liveStepSecForReveTask(task: string | null | undefined): number {
  return task === 'tetris_action' ? TETRIS_LIVE_STEP_SEC : REVE_DEFAULT_LIVE_STEP_SEC
}

export function reveLiveHopMatches(actual: number | null | undefined, wanted: number): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - wanted) < 1e-6
}

export function classBarColor(index: number, _count: number): string {
  const palette = ['#38d39f', '#5b8cff', '#c084fc', '#e8b84a', '#ff6b3d', '#22d3ee', '#f472b6']
  return palette[index % palette.length] ?? '#94a3b8'
}

export function labelHotkey(index: number): string | null {
  if (index < 0 || index > 8) return null
  return String(index + 1)
}
