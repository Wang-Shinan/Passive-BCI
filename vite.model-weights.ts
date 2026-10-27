import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ModelHead } from './vite.model-heads.ts'

export type ModelWeight = { id: string; name: string; backend: 'reve' | 'eegnet'; kind: 'backbone' | 'adapter' | 'checkpoint'; file: string; key: string }

export function listModelWeights(root: string): ModelWeight[] {
  const results: ModelWeight[] = []
  function add(base: string, file: string, id: string, backend: ModelWeight['backend'], kind: ModelWeight['kind']) {
    const real = realpathSync(file), relative = path.relative(realpathSync(base), real)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return
    const stat = statSync(real)
    results.push({ id, name: id.split(':').slice(1).join(':'), backend, kind, file: real,
      key: createHash('sha256').update(`${real}:${stat.size}:${stat.mtimeMs}`).digest('hex') })
  }
  function walk(base: string, folder: string, prefix: string, backend: ModelWeight['backend'], kind: ModelWeight['kind']) {
    if (!existsSync(folder)) return
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(base, file, prefix, backend, kind)
      else if (entry.isFile() && /\.(pt|pth)$/.test(entry.name)) add(base, file, prefix + path.relative(base, file).replaceAll('\\', '/'), backend, kind)
    }
  }
  for (const [folder, prefix] of [['recordings/.eegnet', 'eegnet:'], ['checkpoints/eegnet', 'eegnet-assets:']]) {
    const base = path.join(root, folder); walk(base, base, prefix, 'eegnet', 'checkpoint')
  }
  const adapters = path.resolve(process.env.REVE_ADAPTER_ROOT || path.join(root, 'checkpoints/adapters'))
  walk(adapters, adapters, 'reve-adapter:', 'reve', 'adapter')
  const backbones = path.resolve(process.env.REVE_CHECKPOINT_ROOT || path.join(root, 'checkpoints/backbones'))
  if (existsSync(backbones)) for (const entry of readdirSync(backbones, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'reve-positions') continue
    const file = path.join(backbones, entry.name, 'model.safetensors')
    if (existsSync(file)) add(backbones, file, 'reve-backbone:' + entry.name, 'reve', 'backbone')
  }
  return results.sort((a, b) => a.id.localeCompare(b.id))
}

export function selectModelWeight(root: string, id: string, backend: string): ModelWeight | null {
  if (!id) return null
  const found = listModelWeights(root).find(item => item.id === id && item.backend === backend)
  if (!found) throw new Error('所选权重不存在或不属于当前架构，请刷新权重列表')
  return found
}

export function modelWeightArgs(weight: ModelWeight | null, head: ModelHead | null): string[] {
  if (!weight) return []
  if (weight.backend === 'eegnet') return ['--checkpoint', weight.file]
  if (weight.kind === 'adapter') {
    if (head && (!head.loraCheckpoint || realpathSync(head.loraCheckpoint) !== weight.file)) throw new Error('分类头与所选 LoRA 不配套，请选择配套分类头或权重自带头')
    return ['--lora-checkpoint', weight.file]
  }
  const folder = path.dirname(weight.file)
  if (head && (head.loraCheckpoint || head.encoderId !== path.basename(folder))) throw new Error('分类头与所选骨干不配套')
  return ['--model-dir', folder, '--no-lora', ...(!head ? ['--fresh-head'] : [])]
}
