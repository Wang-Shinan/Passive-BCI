import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NBackSave } from './src/experiments/nback/contracts.ts'
import { summarize } from './src/experiments/nback/engine.ts'

export function saveNBackSnapshot(root: string, data: NBackSave): string {
  if (!data || !/^[a-f0-9-]{36}$/.test(data.id) || !Number.isSafeInteger(data.revision) || data.revision < 0
    || !['running', 'complete', 'interrupted'].includes(data.status)
    || typeof data.subjectId !== 'string' || data.subjectId.length > 200
    || !Number.isFinite(Date.parse(data.startedAt)) || !Number.isFinite(Date.parse(data.updatedAt))
    || !data.config || ![1, 2, 3].includes(data.config.n)
    || !Array.isArray(data.trials) || data.trials.length > 103
    || !Array.isArray(data.results) || data.results.length > data.trials.length
    || !Array.isArray(data.events) || data.events.length > 1000) {
    throw new Error('Invalid N-back snapshot')
  }
  const stem = `nback_${data.id}`
  const dir = join(root, stem)
  const path = join(dir, 'behavior.json')
  if (existsSync(path)) {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as NBackSave
    if (previous.revision > data.revision) return `recordings/${stem}`
  }
  const summary = summarize(data.results)
  mkdirSync(dir, { recursive: true })
  const atomic = (name: string, content: string) => {
    writeFileSync(join(dir, name + '.tmp'), content, 'utf8')
    renameSync(join(dir, name + '.tmp'), join(dir, name))
  }
  atomic('behavior.json', JSON.stringify({ ...data, schema: 'passive-bci.nback.v1', stimulusType: 'letter', summary }, null, 2))
  atomic('events.jsonl', data.events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  // Behavioral snapshots are checkpoints until explicitly completed; no EEG stream is fabricated.
  atomic('session.json', JSON.stringify({
    schema: 'passive-bci.session.v1', id: data.id, dir: stem,
    experiment: 'nback', subjectId: data.subjectId,
    startedAt: data.startedAt, stoppedAt: data.updatedAt,
    status: data.status === 'complete' ? 'complete' : 'interrupted', eeg: null,
    notes: 'N-back 字母任务 · 行为数据（EEG 如有录制，保存在关联采集会话）',
    game: { ...data.config, seed: data.seed, ...summary, reason: data.reason, eegSessionRel: data.eegSessionRel },
  }, null, 2))
  return `recordings/${stem}`
}
