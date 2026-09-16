import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { modelHeadArgs, selectModelHead, type ModelHead } from './vite.model-heads'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function head(): ModelHead {
  const dir = mkdtempSync(path.join(tmpdir(), 'model-head-test-'))
  roots.push(dir)
  const stateFile = path.join(dir, 'head.pt')
  writeFileSync(stateFile, '')
  return { id: 'head.pt', name: 'head.pt', stateFile, task: 'smr_control', encoderId: 'reve-base',
    classes: 4, available: true, reason: '', loraCheckpoint: null, size: 'base' }
}
describe('linear head selection', () => {
  it('rejects unknown paths, incompatible tasks and unavailable adapters before launch', () => {
    const item = head()
    expect(selectModelHead([item], item.id, 'smr_control')).toBe(item)
    expect(() => selectModelHead([item], '../head.pt', 'smr_control')).toThrow()
    expect(() => selectModelHead([item], item.id, 'passive_rating')).toThrow()
    expect(() => selectModelHead([{ ...item, available: false }], item.id, 'smr_control')).toThrow()
    expect(() => selectModelHead([{ ...item, loraCheckpoint: path.join(item.stateFile, 'missing') }], item.id, 'smr_control')).toThrow()
  })
  it('explicitly disables implicit LoRA for a base head and selects the paired adapter otherwise', () => {
    const item = head()
    expect(modelHeadArgs(item)).toEqual(['--state-file', item.stateFile, '--size', 'base', '--no-lora'])
    const adapter = path.join(path.dirname(item.stateFile), 'best.pt')
    expect(modelHeadArgs({ ...item, loraCheckpoint: adapter })).toEqual(['--state-file', item.stateFile, '--size', 'base', '--lora-checkpoint', adapter])
  })
})
