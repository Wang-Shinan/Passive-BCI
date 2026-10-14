import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendRound, createRound, readRound, roundDirectory, loraHistory } from './vite.training-rounds'

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
