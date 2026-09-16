import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveReveLoraArgs } from './reve-launch-options.mjs'

function fixture(t, extra = {}) {
  const ncc = mkdtempSync(path.join(os.tmpdir(), 'gaze-merge-'))
  t.after(() => rmSync(ncc, { recursive: true, force: true }))
  const stateFile = path.join(ncc, 'gaze_smr_active.pt')
  writeFileSync(stateFile, 'fixture head')
  const paired = path.join(ncc, 'checkpoints', 'adapters', 'trained-encoder', 'best.pt')
  mkdirSync(path.dirname(paired), { recursive: true })
  writeFileSync(paired, 'fixture adapter')
  const report = { task: 'gaze_smr', encoderId: 'trained-encoder',
    headSha256: createHash('sha256').update('fixture head').digest('hex'), ...extra }
  writeFileSync(stateFile.replace(/\.pt$/, '.json'), JSON.stringify(report))
  return { task: 'gaze_smr', ncc, stateFile, paired }
}

test('legacy gaze reports resolve their exact encoder, ignoring environment defaults', t => {
  const f = fixture(t)
  assert.deepEqual(resolveReveLoraArgs({ ...f, env: { MODEL_REVE_LORA: 'other.pt' } }), ['--lora-checkpoint', f.paired])
})
test('gaze paired LoRA rejects --no-lora', t => {
  assert.throws(() => resolveReveLoraArgs({ ...fixture(t), argv: ['--no-lora'] }), /requires its paired LoRA/)
})
test('gaze paired LoRA rejects an explicit different checkpoint', t => {
  assert.throws(() => resolveReveLoraArgs({ ...fixture(t), argv: ['--lora-checkpoint', 'other.pt'] }), /differs/)
})
test('gaze paired LoRA accepts its explicit checkpoint', t => {
  const f = fixture(t)
  assert.deepEqual(resolveReveLoraArgs({ ...f, argv: ['--lora-checkpoint', f.paired] }), ['--lora-checkpoint', f.paired])
})
test('mismatched head/report checksum is rejected', t => {
  assert.throws(() => resolveReveLoraArgs(fixture(t, { headSha256: 'wrong' })), /checksum mismatch/)
})
test('missing paired checkpoint does not fall back to a different adapter', t => {
  const f = fixture(t)
  rmSync(f.paired)
  assert.throws(() => resolveReveLoraArgs(f), /Missing paired LoRA/)
})
test('wrong task and traversal-like encoder IDs are rejected', t => {
  assert.throws(() => resolveReveLoraArgs(fixture(t, { task: 'smr_control' })), /task mismatch/)
  assert.throws(() => resolveReveLoraArgs(fixture(t, { encoderId: '../other' })), /valid encoderId/)
})
test('gaze backbone size must match its training configuration', t => {
  assert.throws(() => resolveReveLoraArgs({ ...fixture(t), argv: ['--size', 'large'] }), /size differs/)
})
test('explicit non-gaze arguments override environment defaults', () => {
  assert.deepEqual(resolveReveLoraArgs({ task: 'smr_control', argv: ['--no-lora'], env: { MODEL_REVE_LORA: 'env.pt' } }), ['--no-lora'])
  assert.deepEqual(resolveReveLoraArgs({ task: 'smr_control', argv: ['--lora-checkpoint', 'chosen.pt'], env: { MODEL_REVE_NO_LORA: '1' } }), ['--lora-checkpoint', 'chosen.pt'])
})
test('contradictory explicit flags and missing argument values are rejected', () => {
  assert.throws(() => resolveReveLoraArgs({ task: 'smr_control', argv: ['--no-lora', '--lora-checkpoint', 'x'] }), /mutually exclusive/)
  assert.throws(() => resolveReveLoraArgs({ task: 'smr_control', argv: ['--lora-checkpoint'] }), /Missing value/)
})
