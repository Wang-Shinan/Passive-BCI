import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveNBackSnapshot } from './vite.nback-storage'
import { listSessionSummaries, zipSessionDir } from './vite.record-library'
import { generateTrials, scoreTrial } from './src/experiments/nback/engine'
import type { NBackSave } from './src/experiments/nback/storage'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nback-storage-test-'))
  roots.push(root)
  const trials = generateTrials(1, 20, 123)
  const snapshot: NBackSave = {
    id: '2df1aebb-eefe-44ee-b0e4-eecb12345678', revision: 1, subjectId: 'TEST',
    startedAt: '2026-09-16T10:00:00Z', updatedAt: '2026-09-16T10:00:42Z',
    status: 'complete', reason: 'complete', seed: 123,
    config: { n: 1, count: 20, stimulusMs: 500, intervalMs: 2000 }, trials,
    results: trials.map((trial, index) => scoreTrial(trial, index, trial.target ? 300 : null)),
    events: [{ t: 0, experiment: 'nback', type: 'block_start' }], eegSessionRel: null,
  }
  return { root, snapshot }
}
describe('N-back disk storage', () => {
  it('stores behavior without EEG, exposes it in the library and ZIP, and rejects stale writes', () => {
    const { root, snapshot } = setup()
    const rel = saveNBackSnapshot(root, snapshot)
    const stem = rel.slice('recordings/'.length)
    const [session] = listSessionSummaries(root)
    expect(session).toMatchObject({ experiment: 'nback', status: 'complete', eegBytes: 0, events: 1, durationSec: 42 })
    expect(session!.files.map((file) => file.name)).toContain('behavior.json')
    expect(zipSessionDir(root, stem)!.includes(Buffer.from('behavior.json'))).toBe(true)
    saveNBackSnapshot(root, { ...snapshot, revision: 0, status: 'running', results: [] })
    const stored = JSON.parse(readFileSync(join(root, stem, 'behavior.json'), 'utf8'))
    expect(stored.summary.accuracy).toBe(1)
    expect(stored.status).toBe('complete')
    expect(readdirSync(root)).toHaveLength(1)
  })
  it('keeps aborted results and blocks path traversal', () => {
    const { root, snapshot } = setup()
    saveNBackSnapshot(root, { ...snapshot, status: 'interrupted', results: snapshot.results.slice(0, 3) })
    expect(listSessionSummaries(root)[0]!.status).toBe('interrupted')
    expect(() => saveNBackSnapshot(root, { ...snapshot, id: '../escape' })).toThrow()
  })
})
