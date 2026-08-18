export type ReveTaskId = 'passive_rating' | 'smr_control' | 'tetris_action'

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
    label: '评分 · 差 / 中 / 好',
    short: '评分头',
    semantics: 'ordinal_rating_3',
    classNames: ['差', '中', '好'],
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

export function classBarColor(index: number, count: number): string {
  if (count === 3 && index === 0) return 'var(--danger)'
  if (count === 3 && index === 2) return 'var(--accent-2)'
  if (count === 3) return 'var(--warn)'
  const palette = ['#38d39f', '#5b8cff', '#c084fc', '#e8b84a', '#ff6b3d', '#22d3ee', '#f472b6']
  return palette[index % palette.length] ?? '#94a3b8'
}

export function labelHotkey(index: number): string | null {
  if (index < 0 || index > 8) return null
  return String(index + 1)
}
