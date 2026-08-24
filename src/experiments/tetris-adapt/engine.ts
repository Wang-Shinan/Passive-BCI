import { mulberry32 } from '../../lib/rng'
import {
  CUE_SEC,
  FEEDBACK_SEC,
  ITI_SEC,
  POST_SEC,
  balancedTargets,
} from '../smr-adapt/engine'
import type { SmrTask, TargetDir, TrialOutcome } from '../smr-adapt/smrControl'
import type { CellPos, MiniWidth } from './miniBoard'
import type { PieceType } from '../tetris/engine'
import {
  FEET_CLASS_NAME,
  FEET_INTENDED_ACTION,
  classNameForSmrTarget,
  type SmrClassName,
} from './smrClass'

export { CUE_SEC, FEEDBACK_SEC, ITI_SEC, POST_SEC }
export { FEET_CLASS_NAME, FEET_INTENDED_ACTION, classNameForSmrTarget }

export const OVERLAP_FEEDBACK_SEC = 8

export type Phase = 'idle' | 'iti' | 'cue' | 'feedback' | 'post' | 'done'
export type PlanId = 'quick' | 'standard'
export type TrialKind = 'smr' | 'overlap' | 'collect'
export type AdaptOutcome = TrialOutcome | 'recorded'

export type PlanBlock =
  | { kind: 'smr'; task: Extract<SmrTask, 'LR' | 'UD'>; trials: number }
  | { kind: 'overlap'; boardWidth: MiniWidth; trials: number }
  | { kind: 'collect'; className: typeof FEET_CLASS_NAME; intendedAction: typeof FEET_INTENDED_ACTION; trials: number }

export type PlanSpec = {
  id: PlanId
  label: string
  hint: string
  blocks: PlanBlock[]
}

export const PLANS: Record<PlanId, PlanSpec> = {
  quick: {
    id: 'quick',
    label: '快速',
    hint: '左移/右移 20 + 旋转/下落 20 + 脚想象/速降 20（只采标签），再宽 5 / 宽 7 各 20，约 100 试次',
    blocks: [
      { kind: 'smr', task: 'LR', trials: 20 },
      { kind: 'smr', task: 'UD', trials: 20 },
      { kind: 'collect', className: FEET_CLASS_NAME, intendedAction: FEET_INTENDED_ACTION, trials: 20 },
      { kind: 'overlap', boardWidth: 5, trials: 20 },
      { kind: 'overlap', boardWidth: 7, trials: 20 },
    ],
  },
  standard: {
    id: 'standard',
    label: '标准',
    hint: '左移/右移 40 + 旋转/下落 40 + 脚想象/速降 40（只采标签），再宽 5 / 宽 7 各 40，约 200 试次',
    blocks: [
      { kind: 'smr', task: 'LR', trials: 40 },
      { kind: 'smr', task: 'UD', trials: 40 },
      { kind: 'collect', className: FEET_CLASS_NAME, intendedAction: FEET_INTENDED_ACTION, trials: 40 },
      { kind: 'overlap', boardWidth: 5, trials: 40 },
      { kind: 'overlap', boardWidth: 7, trials: 40 },
    ],
  },
}

export type PoseLog = {
  x: number
  y: number
  rot: number
  cells: CellPos[]
}

export type TrialRecord = {
  index: number
  kind: TrialKind
  task?: Extract<SmrTask, 'LR' | 'UD'>
  target?: TargetDir
  className?: SmrClassName
  intendedAction?: typeof FEET_INTENDED_ACTION
  control?: boolean
  boardWidth?: MiniWidth
  pieceType?: PieceType
  teacher?: PoseLog
  subject?: PoseLog
  outcome: AdaptOutcome | null
  hit: TargetDir | null
  feedbackSec: number
}

export type SessionState = {
  plan: PlanSpec
  trials: TrialRecord[]
  cursor: number
  phase: Phase
  phaseStartedAt: number
  seed: number
}

export function planTrialTotal(plan: PlanSpec): number {
  return plan.blocks.reduce((sum, block) => sum + block.trials, 0)
}

export function buildTrials(plan: PlanSpec, seed: number): TrialRecord[] {
  const rng = mulberry32(seed)
  const trials: TrialRecord[] = []
  for (const block of plan.blocks) {
    if (block.kind === 'smr') {
      const targets = balancedTargets(block.task, block.trials, rng)
      for (const target of targets) {
        trials.push({
          index: trials.length,
          kind: 'smr',
          task: block.task,
          target,
          className: classNameForSmrTarget(target),
          control: true,
          outcome: null,
          hit: null,
          feedbackSec: 0,
        })
      }
      continue
    }
    if (block.kind === 'collect') {
      for (let i = 0; i < block.trials; i++) {
        trials.push({
          index: trials.length,
          kind: 'collect',
          className: block.className,
          intendedAction: block.intendedAction,
          control: false,
          outcome: null,
          hit: null,
          feedbackSec: 0,
        })
      }
      continue
    }
    for (let i = 0; i < block.trials; i++) {
      trials.push({
        index: trials.length,
        kind: 'overlap',
        boardWidth: block.boardWidth,
        outcome: null,
        hit: null,
        feedbackSec: 0,
      })
    }
  }
  return trials
}

export function createSession(plan: PlanSpec, seed: number, now = 0): SessionState {
  return {
    plan,
    trials: buildTrials(plan, seed),
    cursor: 0,
    phase: 'idle',
    phaseStartedAt: now,
    seed,
  }
}

export function currentTrial(session: SessionState): TrialRecord | null {
  return session.trials[session.cursor] ?? null
}

export function startSession(session: SessionState, now: number): SessionState {
  if (session.trials.length === 0) return { ...session, phase: 'done', phaseStartedAt: now }
  return { ...session, cursor: 0, phase: 'iti', phaseStartedAt: now }
}

export function phaseDuration(phase: Phase, trial: TrialRecord | null = null): number {
  if (phase === 'iti') return ITI_SEC
  if (phase === 'cue') return CUE_SEC
  if (phase === 'feedback') {
    return trial?.kind === 'overlap' ? OVERLAP_FEEDBACK_SEC : FEEDBACK_SEC
  }
  if (phase === 'post') return POST_SEC
  return 0
}

export function patchTrial(
  session: SessionState,
  index: number,
  patch: Partial<TrialRecord>,
): SessionState {
  const trials = session.trials.map((item, i) => (i === index ? { ...item, ...patch } : item))
  return { ...session, trials }
}

export function finishTrial(
  session: SessionState,
  outcome: AdaptOutcome,
  hit: TargetDir | null,
  feedbackSec: number,
  now: number,
  extra: Partial<TrialRecord> = {},
): SessionState {
  const trial = currentTrial(session)
  if (!trial || session.phase !== 'feedback') return session
  const trials = session.trials.map((item, index) =>
    index === session.cursor
      ? { ...item, ...extra, outcome, hit, feedbackSec }
      : item,
  )
  return { ...session, trials, phase: 'post', phaseStartedAt: now }
}

export function advancePhase(session: SessionState, now: number): SessionState {
  if (session.phase === 'iti') return { ...session, phase: 'cue', phaseStartedAt: now }
  if (session.phase === 'cue') return { ...session, phase: 'feedback', phaseStartedAt: now }
  if (session.phase === 'post') {
    const next = session.cursor + 1
    if (next >= session.trials.length) {
      return { ...session, cursor: next, phase: 'done', phaseStartedAt: now }
    }
    return { ...session, cursor: next, phase: 'iti', phaseStartedAt: now }
  }
  return session
}

export function instructionFor(trial: TrialRecord | null): string {
  if (!trial) return '选择计划后开始。先在完整井里左移、右移、旋转、下落，再采脚想象（速降，只打标签），再在窄井上对齐落点。'
  if (trial.kind === 'collect') {
    return '想象双脚反复蹬踏。对应方块速降，本轮只采 EEG 标签，不控方块。'
  }
  if (trial.kind === 'smr' && trial.task === 'LR') {
    return '左手开合 → 左移；右手开合 → 右移。把活块移到高亮列。'
  }
  if (trial.kind === 'smr' && trial.target === 'up') {
    return '双手开合 → 旋转，对齐绿色虚影。'
  }
  if (trial.kind === 'smr') {
    return '放空休息 → 下落，对齐绿色落点。'
  }
  return `窄井宽 ${trial.boardWidth}：教师自动转角，你负责左右对齐重叠。`
}

export function cueLabel(trial: TrialRecord): string {
  if (trial.kind === 'collect') return '想象双脚蹬踏 · 速降（只采标签）'
  if (trial.kind === 'smr') {
    if (trial.target === 'left') return '把方块移到左侧'
    if (trial.target === 'right') return '把方块移到右侧'
    if (trial.target === 'up') return '旋转'
    return '下落，对齐落点'
  }
  return '教师自动转角，你负责左右对齐重叠'
}

export type BlockScore = {
  key: string
  label: string
  n: number
  hits: number
  misses: number
  timeouts: number
  recorded: number
  rate: number | null
}

function scoreGroup(
  key: string,
  label: string,
  subset: readonly TrialRecord[],
): BlockScore | null {
  const done = subset.filter((trial) => trial.outcome)
  if (done.length === 0) return null
  const hits = done.filter((trial) => trial.outcome === 'hit').length
  const misses = done.filter((trial) => trial.outcome === 'miss').length
  const timeouts = done.filter((trial) => trial.outcome === 'timeout').length
  const recorded = done.filter((trial) => trial.outcome === 'recorded').length
  const scored = hits + misses + timeouts
  return {
    key,
    label,
    n: done.length,
    hits,
    misses,
    timeouts,
    recorded,
    rate: scored > 0 ? hits / scored : null,
  }
}

export function scoresByBlock(trials: readonly TrialRecord[]): BlockScore[] {
  return [
    scoreGroup(
      'LR',
      '左移/右移',
      trials.filter((trial) => trial.kind === 'smr' && trial.task === 'LR'),
    ),
    scoreGroup(
      'UD',
      '旋转/下落',
      trials.filter((trial) => trial.kind === 'smr' && trial.task === 'UD'),
    ),
    scoreGroup(
      'FEET',
      '脚想象 · 速降',
      trials.filter((trial) => trial.kind === 'collect' && trial.className === FEET_CLASS_NAME),
    ),
    scoreGroup(
      'W5',
      '宽 5',
      trials.filter((trial) => trial.kind === 'overlap' && trial.boardWidth === 5),
    ),
    scoreGroup(
      'W7',
      '宽 7',
      trials.filter((trial) => trial.kind === 'overlap' && trial.boardWidth === 7),
    ),
  ].filter((row): row is BlockScore => row != null)
}

export function overallHitRate(trials: readonly TrialRecord[]): number | null {
  const done = trials.filter((trial) => trial.outcome && trial.outcome !== 'recorded')
  if (done.length === 0) return null
  return done.filter((trial) => trial.outcome === 'hit').length / done.length
}
