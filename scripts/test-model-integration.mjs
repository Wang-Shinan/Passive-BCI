import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ModelOperation } from '../src/lib/model-runtime/modelOperation.ts'
import { OperationGate } from '../vite.operation-gate.ts'
import { readGazeHead } from '../vite.gaze-heads.ts'
import { normalizeGazePrediction, gazeReportMatchesSource } from '../src/experiments/smr-gaze/gazeModelContract.ts'

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
test('start A cannot complete after explicit stop even if HTTP ignores cancellation', async () => {
  const op = new ModelOperation(), pending = deferred()
  const start = op.run(() => pending.promise); start.catch(() => {})
  op.cancel(); pending.resolve('old model')
  await assert.rejects(start, { name: 'AbortError' })
  assert.equal(op.busy, false)
})
test('old finally cannot release a newer operation', async () => {
  const op = new ModelOperation(), a = deferred(), b = deferred()
  const old = op.run(() => a.promise); old.catch(() => {}); op.cancel()
  const next = op.run(() => b.promise)
  a.resolve('old'); await assert.rejects(old)
  assert.equal(op.busy, true)
  b.resolve('new'); assert.equal(await next, 'new'); assert.equal(op.busy, false)
})
test('concurrent starts are rejected and external abort cancels ownership', async () => {
  const op = new ModelOperation(), pending = deferred(), controller = new AbortController()
  const a = op.run(() => pending.promise, controller.signal); a.catch(() => {})
  await assert.rejects(op.run(async () => 'other'), /正在进行/)
  controller.abort(); pending.resolve('too late'); await assert.rejects(a, { name: 'AbortError' })
})
test('recording in any tab prevents model mutation until all recordings finish', () => {
  const gate = new OperationGate()
  gate.attachRecording('one'); gate.attachRecording('two')
  assert.throws(() => gate.beginModelChange(), /录制期间/)
  gate.detachRecording('one'); assert.throws(() => gate.beginModelChange(), /录制期间/)
  gate.detachRecording('two'); gate.beginModelChange()()
})
test('model mutation prevents recording, and stale cleanup cannot unlock another mutation', () => {
  const gate = new OperationGate(), releaseA = gate.beginModelChange()
  assert.throws(() => gate.attachRecording('during'), /模型正在/)
  releaseA(); const releaseB = gate.beginModelChange(); releaseA()
  assert.throws(() => gate.assertCanRecord(), /模型正在/)
  releaseB(); gate.attachRecording('after')
})
function gazeFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gaze-catalog-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const folder = path.join(root, 'recordings', '.reve-heads', 'gaze-smr', '20260917T123000Z')
  mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, 'head.pt'), 'paired-head')
  const report = { task: 'gaze_smr', modelRevision: 'gaze-rev-A', subjectId: 'S01', encoderId: 'reve-base',
    channels: ['C3', 'C4'], sampleRate: 250, classNames: ['left','right','up','down'], activeClasses: ['left','right'],
    headSha256: createHash('sha256').update('paired-head').digest('hex'), trials: 20, bootstrapGazeOnly: false,
    evaluation: { n: 4, balancedAccuracy: .75, recalls: [.5,1] } }
  const save = () => writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report))
  save(); return { root, folder, report, save, id: 'gaze-smr/20260917T123000Z/head.pt' }
}
test('historical gaze selection pairs head.pt with its own report.json, not active', t => {
  const f = gazeFixture(t), head = readGazeHead(f.root, f.id, f.root)
  assert.equal(head.id, f.id); assert.equal(head.gazeReport.modelRevision, 'gaze-rev-A')
  assert.equal(head.reportFile, path.join(f.folder, 'report.json'))
  assert.equal(head.loraCheckpoint, null); assert.equal(head.size, 'base')
})
test('changing a report changes configuration identity even at the same path', t => {
  const f = gazeFixture(t), old = readGazeHead(f.root, f.id, f.root)
  f.report.modelRevision = 'gaze-rev-B'; f.save()
  assert.notEqual(readGazeHead(f.root, f.id, f.root).configurationKey, old.configurationKey)
})
test('head/report checksum mismatch and incomplete metadata fail closed', t => {
  const f = gazeFixture(t)
  f.report.headSha256 = 'wrong'; f.save(); assert.throws(() => readGazeHead(f.root, f.id, f.root), /校验和/)
  f.report.channels = []; f.save(); assert.throws(() => readGazeHead(f.root, f.id, f.root), /有效任务/)
})
test('model IDs cannot escape the allowlist, including symlinks outside the head root', t => {
  const f = gazeFixture(t)
  assert.throws(() => readGazeHead(f.root, '../head.pt', f.root), /无效/)
  const outside = path.join(f.root, 'outside.pt'); writeFileSync(outside, 'paired-head')
  rmSync(path.join(f.folder, 'head.pt')); symlinkSync(outside, path.join(f.folder, 'head.pt'))
  assert.throws(() => readGazeHead(f.root, f.id, f.root), /越界/)
})
test('binary gaze normalization masks inactive logits as well as probabilities', () => {
  const p = { model_revision:'r', probabilities:[.1,.2,.3,.4], logits:[1,2,3,4], class_id:3, class_name:'down' }
  const n = normalizeGazePrediction(p, { modelRevision:'r', activeClasses:['left','right'] })
  assert.equal(n.class_name, 'right'); assert.equal(n.class_id, 1)
  assert.ok(Math.abs(n.probabilities[1] - 2/3) < 1e-8)
  assert.deepEqual(n.probabilities.slice(2), [0,0]); assert.ok(n.logits[2] < -1e6 && n.logits[3] < -1e6)
})
test('gaze revision, montage order, subject and rate are checked', () => {
  const report = { modelRevision:'r', activeClasses:['left','right'], subjectId:'S01', channels:['C3','C4'], sampleRate:250 }
  assert.equal(normalizeGazePrediction({model_revision:'old',probabilities:[.5,.5,0,0]}, report), null)
  assert.equal(gazeReportMatchesSource(report,'S01',['C3','C4'],250), true)
  assert.equal(gazeReportMatchesSource(report,'S02',['C3','C4'],250), false)
  assert.equal(gazeReportMatchesSource(report,'S01',['C4','C3'],250), false)
  assert.equal(gazeReportMatchesSource(report,'S01',['C3','C4'],200), false)
})
