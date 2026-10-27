import type { LiveFeatureSnapshot } from '../../lib/features/bandFeatures'

// engagement_score duplicates focus_score, so it must not get a second vote.
export const ATTENTION_VOTE_FEATURES = ['focus_score', 'rel_power_alpha', 'rel_power_theta', 'spect_entropy', 'hjorth_mobility']
export const ATTENTION_VOTE_STORAGE = 'passive-bci.video-attention-vote.v1'
export type CalibrationPhase = 'rest' | 'prepare' | 'focus' | 'done'
type Rule = { feature: string; threshold: number; above: boolean; accuracy: number }
type Separation = { restRecall: number; focusRecall: number; balancedAccuracy: number }
export type AttentionVoteModel = {
  version: 1; context: string; createdAt: string; rules: Rule[]; minimumVotes: number
  validation: Separation & { restCount: number; focusCount: number }
  counts: { rest: number; focus: number }
}

function validWindow(p: LiveFeatureSnapshot): boolean {
  return p.nChannels > 0 && Number.isFinite(p.t) && Number.isFinite(p.windowSec) && p.windowSec > 0
    && ATTENTION_VOTE_FEATURES.every(key => Number.isFinite(p.values[key]) && p.values[key] >= 0)
}

/** Collect full, non-overlapping windows within each 20 s cue; never count a frozen feature twice. */
export class AttentionCalibrationRun {
  phase: CalibrationPhase = 'rest'
  startedAt: number
  private lastTick: number
  readonly context: string
  readonly rest: LiveFeatureSnapshot[] = []
  readonly focus: LiveFeatureSnapshot[] = []

  constructor(now: number, context: string) { this.startedAt = this.lastTick = now; this.context = context }

  tick(sample: LiveFeatureSnapshot | null, sourceAt: number, now: number, live: boolean) {
    if (!live || !Number.isFinite(now) || !Number.isFinite(sourceAt) || now < sourceAt || now - sourceAt > 1500
      || now < this.lastTick || now - this.lastTick > 1500 || !sample || now < sample.t || now - sample.t > 1500) {
      throw new Error('EEG 或特征中断，本轮校准已停止；恢复连接后请重新开始。')
    }
    this.lastTick = now
    const duration = this.phase === 'prepare' ? 3000 : 20000
    if (this.phase !== 'done' && now - this.startedAt >= duration) {
      this.phase = this.phase === 'rest' ? 'prepare' : this.phase === 'prepare' ? 'focus' : 'done'
      this.startedAt = now
    }
    if (this.phase === 'rest' || this.phase === 'focus') {
      const rows = this[this.phase]
      const windowMs = sample.windowSec * 1000
      if (validWindow(sample) && sample.t - windowMs >= this.startedAt
        && (!rows.length || sample.t - rows.at(-1)!.t >= windowMs)) {
        rows.push({ ...sample, values: Object.fromEntries(ATTENTION_VOTE_FEATURES.map(key => [key, sample.values[key]])) })
      }
    }
    return { phase: this.phase, remaining: this.phase === 'done' ? 0
      : Math.ceil(((this.phase === 'prepare' ? 3000 : 20000) - (now - this.startedAt)) / 1000) }
  }
}

function separation(rest: boolean[], focus: boolean[]): Separation {
  const restRecall = rest.filter(v => !v).length / rest.length
  const focusRecall = focus.filter(Boolean).length / focus.length
  return { restRecall, focusRecall, balancedAccuracy: (restRecall + focusRecall) / 2 }
}

export function attentionVote(values: Record<string, number>, model: Pick<AttentionVoteModel, 'rules' | 'minimumVotes'>) {
  if (!model.rules.length || model.rules.some(r => !Number.isFinite(values[r.feature]) || values[r.feature] < 0)) return null
  const votes = model.rules.filter(r => r.above ? values[r.feature] >= r.threshold : values[r.feature] <= r.threshold).length
  return { votes, total: model.rules.length, focused: votes >= model.minimumVotes }
}

export function fitAttentionVote(rest: LiveFeatureSnapshot[], focus: LiveFeatureSnapshot[], context: string): AttentionVoteModel {
  for (const rows of [rest, focus]) {
    if (rows.length < 15 || rows.length > 20 || rows.some((p, i) => !validWindow(p)
      || (i > 0 && p.t - rows[i - 1].t < p.windowSec * 1000))) {
      throw new Error('每个状态需要至少 15 个不重叠的有效窗口，请保持连接并重新校准。')
    }
  }
  // ponytail: a single short session; reserve the final third with a one-window gap.
  // For a reusable classifier, collect repeated alternating blocks on another session.
  const split = (rows: LiveFeatureSnapshot[]) => {
    const cut = Math.floor(rows.length * .65)
    return { train: rows.slice(0, cut), validation: rows.slice(cut + 1) }
  }
  const r = split(rest), f = split(focus)
  const rules: Rule[] = []
  for (const feature of ATTENTION_VOTE_FEATURES) {
    const values = [...new Set([...r.train, ...f.train].map(p => p.values[feature]))].sort((a, b) => a - b)
    let best: Rule | null = null
    // ponytail: exhaustive midpoint search is bounded by 40 calibration windows; use a sorted sweep for longer sessions.
    for (let i = 1; i < values.length; i++) for (const above of [true, false]) {
      const threshold = values[i - 1] / 2 + values[i] / 2
      const predict = (p: LiveFeatureSnapshot) => above ? p.values[feature] >= threshold : p.values[feature] <= threshold
      const accuracy = separation(r.train.map(predict), f.train.map(predict)).balancedAccuracy
      if (!best || accuracy > best.accuracy) best = { feature, threshold, above, accuracy }
    }
    if (best && best.accuracy >= .6) rules.push(best)
  }
  rules.sort((a, b) => b.accuracy - a.accuracy)
  rules.splice(3)
  if (!rules.length) throw new Error('两种状态的特征没有足够差异，请重新校准。')
  let minimumVotes = 1
  let bestScore = -1, bestRest = -1
  for (let n = 1; n <= rules.length; n++) {
    const predict = (p: LiveFeatureSnapshot) => attentionVote(p.values, { rules, minimumVotes: n })!.focused
    const score = separation(r.train.map(predict), f.train.map(predict))
    if (score.balancedAccuracy > bestScore || (score.balancedAccuracy === bestScore && score.restRecall >= bestRest)) {
      minimumVotes = n; bestScore = score.balancedAccuracy; bestRest = score.restRecall
    }
  }
  const predict = (p: LiveFeatureSnapshot) => attentionVote(p.values, { rules, minimumVotes })!.focused
  const validation = separation(r.validation.map(predict), f.validation.map(predict))
  if (validation.balancedAccuracy < .6 || Math.min(validation.restRecall, validation.focusRecall) < .5) {
    throw new Error(`后段验证区分不足（均衡正确率 ${(validation.balancedAccuracy * 100).toFixed(0)}%），请重新校准。`)
  }
  return { version: 1, context, createdAt: new Date().toISOString(), rules, minimumVotes,
    counts: { rest: rest.length, focus: focus.length },
    validation: { ...validation, restCount: r.validation.length, focusCount: f.validation.length } }
}

export function parseAttentionVote(raw: string | null): AttentionVoteModel | null {
  try {
    const m = JSON.parse(raw ?? 'null') as AttentionVoteModel | null
    const fraction = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1
    if (!m || m.version !== 1 || typeof m.context !== 'string' || typeof m.createdAt !== 'string'
      || !Array.isArray(m.rules) || !m.rules.length || m.rules.length > 3
      || new Set(m.rules.map(r => r.feature)).size !== m.rules.length
      || !m.rules.every(r => ATTENTION_VOTE_FEATURES.includes(r.feature) && Number.isFinite(r.threshold)
        && r.threshold >= 0 && typeof r.above === 'boolean' && fraction(r.accuracy))
      || !Number.isInteger(m.minimumVotes) || m.minimumVotes < 1 || m.minimumVotes > m.rules.length
      || !m.validation || ![m.validation.restRecall, m.validation.focusRecall, m.validation.balancedAccuracy].every(fraction)
      || m.validation.balancedAccuracy < .6 || Math.min(m.validation.restRecall, m.validation.focusRecall) < .5
      || ![m.validation.restCount, m.validation.focusCount].every(n => Number.isInteger(n) && n >= 3 && n <= 20)
      || !m.counts || ![m.counts.rest, m.counts.focus].every(n => Number.isInteger(n) && n >= 15 && n <= 20)) return null
    return m
  } catch { return null }
}
