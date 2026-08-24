import { mulberry32, shuffleInPlace } from '../../lib/rng'
import {
  proficient,
  pvc,
  type SmrTask,
  type TargetDir,
  type TrialOutcome,
} from './smrControl'

export const ITI_SEC = 2
export const CUE_SEC = 2
export const FEEDBACK_SEC = 6
export const POST_SEC = 1

export type Phase = 'idle' | 'iti' | 'cue' | 'feedback' | 'post' | 'done'

export type PlanId = 'quick' | 'standard' | 'full'

export type PlanBlock = {
  task: SmrTask
  runs: number
  trialsPerRun: number
}

export type PlanSpec = {
  id: PlanId
  label: string
  hint: string
  blocks: PlanBlock[]
}

export const PLANS: Record<PlanId, PlanSpec> = {
  quick: {
    id: 'quick',
    label: '快速适配',
    hint: 'LR 20 + UD 20，约 6 分钟',
    blocks: [
      { task: 'LR', runs: 1, trialsPerRun: 20 },
      { task: 'UD', runs: 1, trialsPerRun: 20 },
    ],
  },
  standard: {
    id: 'standard',
    label: '标准适配',
    hint: '各 40 trial，约 12 分钟',
    blocks: [
      { task: 'LR', runs: 2, trialsPerRun: 20 },
      { task: 'UD', runs: 2, trialsPerRun: 20 },
    ],
  },
  full: {
    id: 'full',
    label: '含 2D',
    hint: '再加 20 次四向控制',
    blocks: [
      { task: 'LR', runs: 2, trialsPerRun: 20 },
      { task: 'UD', runs: 2, trialsPerRun: 20 },
      { task: '2D', runs: 1, trialsPerRun: 20 },
    ],
  },
}

export type TrialRecord = {
  index: number
  task: SmrTask
  run: number
  target: TargetDir
  outcome: TrialOutcome | null
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

export function taskTargets(task: SmrTask): TargetDir[] {
  if (task === 'LR') return ['left', 'right']
  if (task === 'UD') return ['up', 'down']
  return ['right', 'left', 'up', 'down']
}

export function balancedTargets(task: SmrTask, n: number, rng: () => number): TargetDir[] {
  const classes = taskTargets(task)
  const out: TargetDir[] = []
  while (out.length < n) {
    const block = shuffleInPlace([...classes], rng)
    out.push(...block)
  }
  return out.slice(0, n)
}

export function buildTrials(plan: PlanSpec, seed: number): TrialRecord[] {
  const rng = mulberry32(seed)
  const trials: TrialRecord[] = []
  let run = 0
  for (const block of plan.blocks) {
    for (let r = 0; r < block.runs; r++) {
      run += 1
      const targets = balancedTargets(block.task, block.trialsPerRun, rng)
      for (const target of targets) {
        trials.push({
          index: trials.length,
          task: block.task,
          run,
          target,
          outcome: null,
          hit: null,
          feedbackSec: 0,
        })
      }
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

export function phaseDuration(phase: Phase): number {
  if (phase === 'iti') return ITI_SEC
  if (phase === 'cue') return CUE_SEC
  if (phase === 'feedback') return FEEDBACK_SEC
  if (phase === 'post') return POST_SEC
  return 0
}

export function finishTrial(
  session: SessionState,
  outcome: TrialOutcome,
  hit: TargetDir | null,
  feedbackSec: number,
  now: number,
): SessionState {
  const trial = currentTrial(session)
  if (!trial || session.phase !== 'feedback') return session
  const trials = session.trials.map((item, index) =>
    index === session.cursor ? { ...item, outcome, hit, feedbackSec } : item,
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

export function instructionFor(task: SmrTask): string {
  if (task === 'LR') {
    return '想象左手反复开合 → 光标向左；右手开合 → 向右。'
  }
  if (task === 'UD') {
    return '双手同时开合 → 光标向上；主动放空休息 → 向下。'
  }
  return '左/右手控左右，双手向上，休息向下。'
}

export function cueLabel(target: TargetDir): string {
  if (target === 'left') return '左手开合 → 左'
  if (target === 'right') return '右手开合 → 右'
  if (target === 'up') return '双手开合 → 上'
  return '放空休息 → 下'
}

export type TaskScore = {
  task: SmrTask
  pvc: number
  proficient: boolean
  n: number
  hits: number
  misses: number
  timeouts: number
}

export function scoreHint(scores: readonly TaskScore[]): string | null {
  const lr = scores.find((row) => row.task === 'LR')
  const ud = scores.find((row) => row.task === 'UD')
  if (ud?.proficient && lr && lr.pvc < 0.45 && lr.misses > lr.hits) {
    return 'UD 说明你能上/下调 alpha。LR 低于随机，更像左右符号反了，不是不会做左右想象。下一轮会按 C3/C4 类均值自动对齐极性。'
  }
  if (lr && !lr.proficient && ud && !ud.proficient) {
    return '两个 1D 都未达标。先确认开流且 C3/C4 接触良好，再做一轮快速适配。'
  }
  if (ud && !ud.proficient && lr?.proficient) {
    return '左右可以，上下偏弱：向下请主动放空（抬 alpha），不要想脚或舌。'
  }
  return null
}

export function scoresByTask(trials: readonly TrialRecord[]): TaskScore[] {
  const tasks: SmrTask[] = ['LR', 'UD', '2D']
  return tasks
    .map((task) => {
      const subset = trials.filter((trial) => trial.task === task && trial.outcome)
      const outcomes = subset.map((trial) => trial.outcome!)
      const hits = outcomes.filter((item) => item === 'hit').length
      const misses = outcomes.filter((item) => item === 'miss').length
      const timeouts = outcomes.filter((item) => item === 'timeout').length
      const score = pvc(outcomes)
      return {
        task,
        pvc: score,
        proficient: proficient(task, score),
        n: subset.length,
        hits,
        misses,
        timeouts,
      }
    })
    .filter((row) => row.n > 0)
}
