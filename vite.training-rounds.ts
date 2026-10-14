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

/** Only journaled complete groups from compatible, completed rounds can enter LoRA. */
export function loraHistory(root: string, current: TrainingRound) {
  if (current.imagerySchema !== 'left-right-tongue-rest-v1') throw new Error('本轮不是舌头想象协议，请开始新一轮采集')
  const sessionsFor = (round: TrainingRound) => [...new Set(round.entries
    .filter(e => e.type === 'group_saved').map(e => String(e.data.session).replace(/^recordings\//, '')))]
  const signature = (stem: string) => {
    if (path.basename(stem) !== stem || stem === '.' || stem === '..') throw new Error('无效会话路径')
    const meta = JSON.parse(readFileSync(path.join(root, 'recordings', stem, 'eeg.json'), 'utf8'))
    return JSON.stringify([meta.format, meta.unit, meta.sampleRate, meta.channels, meta.channelNames])
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
