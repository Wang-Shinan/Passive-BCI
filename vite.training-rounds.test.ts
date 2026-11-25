import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendRound, createRound, readRound, readSavedGroupBoundary, roundDirectory, loraHistory } from './vite.training-rounds'
import { createSession, groupedPlan, restoreSavedSession } from './src/experiments/smr-adapt/engine'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('persists independent subject rounds and append-only workflow decisions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'probe-round-')); roots.push(root)
  const id = '11111111-1111-1111-1111-111111111111'
  createRound(root, id, 'participant-X', 0xffffffff)
  appendRound(root, id, 'group_saved', { session: 'group1' })
  appendRound(root, id, 'model_decision', { selected: 'head.pt' })
  expect(readRound(root, id)).toMatchObject({ subjectId: 'participant-X', seed: 0xffffffff,
    entries: [{ type: 'group_saved' }, { type: 'model_decision' }] })
  expect(() => createRound(root, id, 'another-person', 0)).toThrow('已存在')
  expect(() => roundDirectory(root, '../outside')).toThrow()
})

it('rebuilds the next group at its original trial index, using the journaled model decision', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'recover-saved-group-')); roots.push(root)
  const id = '11111111-1111-1111-1111-111111111111'
  const subjectId = 'participant-X'
  const plan = groupedPlan(2, 4)
  const session = createSession(plan, 23)
  createRound(root, id, subjectId, session.seed)
  const events = [{ type: 'group_start', data: { roundId: id, plan } },
    ...session.trials.slice(0, 4).map(({ index, target }) => ({ type: 'trial', data: { index, target, outcome: 'timeout', hit: null, feedbackSec: 6 } })),
    { type: 'group_end', data: { roundId: id, run: 1, complete: true } }]
  const folder = path.join(root, 'recordings', 'group1')
  mkdirSync(folder)
  writeFileSync(path.join(folder, 'events.jsonl'), events.map(event => JSON.stringify({ ...event, subjectId, experiment: 'smr-adapt' })).join('\n'))
  appendRound(root, id, 'group_saved', { session: 'recordings/group1', model: { revision: 'baseline' } })
  expect(readSavedGroupBoundary(root, subjectId)).toMatchObject({ needsProcessing: true })
  appendRound(root, id, 'model_decision', { selected: { revision: 'updated' } })
  const saved = readSavedGroupBoundary(root, subjectId)!
  expect(saved).toMatchObject({ round: { baseline: { revision: 'updated' }, sessions: ['group1'] }, needsProcessing: false })
  const restored = restoreSavedSession(saved.plan, saved.round.seed, saved.results)
  expect(restored).toMatchObject({ phase: 'rest', cursor: 4 })
  expect(restored.trials[4]).toEqual(session.trials[4])
  expect(readSavedGroupBoundary(root, 'other')).toBeNull()
  appendRound(root, id, 'interrupted', {})
  expect(readSavedGroupBoundary(root, subjectId)).toBeNull()
})

it('selects only compatible completed subject rounds and requires the current final group', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lora-history-')); roots.push(root)
  const make = (n: number, subject = 'S01', rate = 250, complete = true, split = true) => {
    const id = `${n}1111111-1111-1111-1111-111111111111`
    createRound(root, id, subject, n)
    const session = `group${n}`
    mkdirSync(path.join(root, 'recordings', session))
    writeFileSync(path.join(root, 'recordings', session, 'eeg.json'), JSON.stringify({ sampleRate: rate, channelNames: ['C3', 'C4'] }))
    appendRound(root, id, 'group_saved', { session, last: complete })
    if (complete) appendRound(root, id, 'complete', {})
    if (split) writeFileSync(path.join(roundDirectory(root, id), 'split.json'), '{}')
    return readRound(root, id)
  }
  const first = make(1)
  make(2, 'other')
  make(3, 'S01', 500)
  make(4, 'S01', 250, false)
  make(5, 'S01', 250, true, false)
  const legacy = make(7)
  delete legacy.imagerySchema
  writeFileSync(path.join(roundDirectory(root, legacy.id), 'round.json'), JSON.stringify(legacy))
  const current = make(6, 'S01', 250, false)
  expect(() => loraHistory(root, current)).toThrow('最后一组')
  appendRound(root, current.id, 'group_saved', { session: 'group6', last: true })
  const history = loraHistory(root, readRound(root, current.id))
  expect(history.rounds.map(r => r.id)).toEqual([first.id, current.id])
  expect(history.skipped).toHaveLength(3)
  expect(history.skipped).toContainEqual({ roundId: legacy.id, reason: '运动想象标签不兼容（旧双手协议）' })
  expect(() => loraHistory(root, legacy)).toThrow('不是舌头想象协议')
})
