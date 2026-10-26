import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listModelWeights, selectModelWeight, modelWeightArgs } from './vite.model-weights'
import type { ModelHead } from './vite.model-heads'
const roots: string[] = []
afterEach(() => { roots.forEach(root => rmSync(root, { recursive: true, force: true })); roots.length = 0 })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'model-weights-')); roots.push(root)
  for (const file of ['recordings/.eegnet/saved.pt', 'checkpoints/adapters/trained/best.pt', 'checkpoints/backbones/reve-base/model.safetensors']) {
    const full = path.join(root, file); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, 'fixture')
  }
  return root
}
it('lists separate full EEGNet, REVE base and adapter weights and rejects cross-architecture IDs', () => {
  const root = fixture()
  expect(listModelWeights(root)).toHaveLength(3)
  expect(selectModelWeight(root, 'eegnet:saved.pt', 'eegnet')?.kind).toBe('checkpoint')
  expect(() => selectModelWeight(root, 'eegnet:saved.pt', 'reve')).toThrow()
  expect(() => selectModelWeight(root, '../outside.pt', 'eegnet')).toThrow()
})
it('binds an adapter to its matching head and explicitly initializes the unadapted base', () => {
  const root = fixture()
  const adapter = selectModelWeight(root, 'reve-adapter:trained/best.pt', 'reve')!
  expect(modelWeightArgs(adapter, null)).toEqual(['--lora-checkpoint', adapter.file])
  expect(() => modelWeightArgs(adapter, { loraCheckpoint: null } as ModelHead)).toThrow('不配套')
  const base = selectModelWeight(root, 'reve-backbone:reve-base', 'reve')!
  expect(modelWeightArgs(base, null)).toContain('--fresh-head')
  expect(() => modelWeightArgs(base, { encoderId: 'different' } as ModelHead)).toThrow('不配套')
})
