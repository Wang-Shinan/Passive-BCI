import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type TrainingRound = {
  id: string; subjectId: string; seed: number; createdAt: string; imagerySchema?: string
  entries: Array<{ at: string; type: string; data: Record<string, unknown> }>
}
export function roundDirectory(root: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效轮次编号')
  return path.join(root, 'recordings', '.training-rounds', id)
}
export function readRound(root: string, id: string): TrainingRound {
  return JSON.parse(readFileSync(path.join(roundDirectory(root, id), 'round.json'), 'utf8')) as TrainingRound
}
function saveRound(root: string, round: TrainingRound): void {
  const dir = roundDirectory(root, round.id)
  mkdirSync(dir, { recursive: true })
  const temporary = path.join(dir, 'round.tmp')
  writeFileSync(temporary, JSON.stringify(round, null, 2))
  renameSync(temporary, path.join(dir, 'round.json'))
}
export function createRound(root: string, id: string, subjectId: unknown, seed: unknown): TrainingRound {
  if (typeof subjectId !== 'string' || !subjectId.trim() || subjectId.length > 100) throw new Error('请填写被试编号')
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('无效随机种子')
  if (existsSync(roundDirectory(root, id))) throw new Error('轮次已存在')
  const round = { id, subjectId, seed, imagerySchema: 'left-right-tongue-rest-v1', createdAt: new Date().toISOString(), entries: [] }
  saveRound(root, round)
  return round
}
export function appendRound(root: string, id: string, type: string, data: Record<string, unknown>): void {
  const round = readRound(root, id)
  round.entries.push({ at: new Date().toISOString(), type, data })
  saveRound(root, round)
}

export function readSavedGroupBoundary(root: string, subjectId: string) {
  const dir = path.join(root, 'recordings', '.training-rounds')
  const latest = (existsSync(dir) ? readdirSync(dir) : [])
    .filter(id => /^[a-f0-9-]{36}$/.test(id))
    .map(id => readRound(root, id))
    .filter(round => round.subjectId === subjectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!latest || latest.entries.some(entry => entry.type === 'interrupted' || entry.type === 'complete')) return null
  const saved = latest.entries.filter(entry => entry.type === 'group_saved')
  const last = saved.at(-1)
  if (!last || last.data.last === true) return null

  const sessions = saved.map(entry => String(entry.data.session).replace(/^recordings\//, ''))
  const events = sessions.map(stem => {
    if (!/^[\w.-]+$/.test(stem) || stem === '.' || stem === '..') throw new Error('无效会话路径')
    return readFileSync(path.join(root, 'recordings', stem, 'events.jsonl'), 'utf8').split(/\r?\n/)
      .filter(Boolean).map(line => JSON.parse(line)).filter(event => event.subjectId === subjectId && event.experiment === 'smr-adapt')
  })
  const plan = events[0]?.find(event => event.type === 'group_start' && event.data?.roundId === latest.id)?.data?.plan
  const block = plan?.blocks?.[0]
  if (plan?.id !== 'grouped' || plan.restBetweenRuns !== true || plan.blocks.length !== 1 || block?.task !== '1D'
    || !Number.isInteger(block.runs) || block.runs > 50 || saved.length >= block.runs
    || !Number.isInteger(block.trialsPerRun) || block.trialsPerRun < 4 || block.trialsPerRun > 200) return null
  const results = []
  for (const [index, group] of events.entries()) {
    const run = index + 1
    const trials = group.filter(event => event.type === 'trial')
    if (!group.some(event => event.type === 'group_end' && event.data?.roundId === latest.id && event.data?.run === run && event.data?.complete)
      || group.some(event => event.type === 'group_interrupted' || event.type === 'trial_invalid' || event.data?.valid === false)
      || trials.length !== block.trialsPerRun) return null
    for (const { data } of trials) {
      if (!data || data.index !== results.length || !['left', 'right', 'up', 'down'].includes(data.target)
        || !['hit', 'miss', 'timeout'].includes(data.outcome) || !Number.isFinite(data.feedbackSec)
        || (data.hit !== null && !['left', 'right', 'up', 'down'].includes(data.hit))) return null
      results.push({ index: data.index, target: data.target, outcome: data.outcome, hit: data.hit, feedbackSec: data.feedbackSec })
    }
  }
  const decision = latest.entries.slice(latest.entries.indexOf(last) + 1).findLast(entry => entry.type === 'model_decision')
  const baseline = decision?.data.selected ?? last.data.model
  if (!baseline) return null
  return { plan, results, round: { id: latest.id, seed: latest.seed, subjectId, sessions, baseline },
    needsProcessing: !decision, message: decision?.data.message, options: last.data.options }
}

/** Only journaled complete groups from compatible, completed rounds can enter LoRA. */
export function loraHistory(root: string, current: TrainingRound) {
  if (current.imagerySchema !== 'left-right-tongue-rest-v1') throw new Error('本轮不是舌头想象协议，请开始新一轮采集')
  const sessionsFor = (round: TrainingRound) => [...new Set(round.entries
    .filter(e => e.type === 'group_saved').map(e => String(e.data.session).replace(/^recordings\//, '')))]
  const signature = (stem: string) => {
    if (path.basename(stem) !== stem || stem === '.' || stem === '..') throw new Error('无效会话路径')
    const folder = path.join(root, 'recordings', stem)
    const meta = JSON.parse(readFileSync(path.join(folder, 'eeg.json'), 'utf8'))
    const recovered = path.join(folder, 'reve-input.json')
    const input = meta.reveInput ?? (existsSync(recovered) ? JSON.parse(readFileSync(recovered, 'utf8')).projection : null)
    return JSON.stringify([meta.format, meta.unit, meta.sampleRate, meta.channels, meta.channelNames,
      input && [input.indices, input.channelNames, input.electrodePositions]])
  }
  const currentSessions = sessionsFor(current)
  if (!currentSessions.length || !current.entries.some(e => e.type === 'group_saved' && e.data.last === true)) {
    throw new Error('只有最后一组保存后才能执行轮末 LoRA')
  }
  const input = signature(currentSessions[0]!)
  if (currentSessions.some(stem => signature(stem) !== input)) throw new Error('本轮输入配置不一致')
  const candidates = readdirSync(path.dirname(roundDirectory(root, current.id)))
    .filter(id => /^[a-f0-9-]{36}$/.test(id) && id !== current.id)
    .map(id => readRound(root, id))
    .filter(round => round.subjectId === current.subjectId && round.entries.some(e => e.type === 'complete')
      && !round.entries.some(e => e.type === 'interrupted'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const skipped: Array<{ roundId: string; reason: string }> = []
  const history = candidates.filter(round => {
    if (round.imagerySchema !== current.imagerySchema || round.imagerySchema !== 'left-right-tongue-rest-v1') {
      skipped.push({ roundId: round.id, reason: '运动想象标签不兼容（旧双手协议）' }); return false
    }
    const sessions = sessionsFor(round)
    if (!sessions.length || !existsSync(path.join(roundDirectory(root, round.id), 'split.json'))) {
      skipped.push({ roundId: round.id, reason: '没有固定试次划分' }); return false
    }
    if (sessions.some(stem => signature(stem) !== input)) {
      skipped.push({ roundId: round.id, reason: '输入配置不兼容' }); return false
    }
    return true
  })
  return { rounds: [...history, current].map(round => ({ id: round.id, seed: round.seed,
    sessions: sessionsFor(round).map(stem => path.join(root, 'recordings', stem)),
    splitLedger: path.join(roundDirectory(root, round.id), 'split.json'),
    recordingManifest: path.join(roundDirectory(root, round.id), 'recordings.json') })), skipped }
}
