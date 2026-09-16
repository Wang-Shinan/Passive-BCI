import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type ModelHead = {
  trainedAt?: string | null; updatedAt?: string | null
  id: string; name: string; task: string | null; encoderId: string | null
  classes: number | null; available: boolean; reason: string
  stateFile: string; loraCheckpoint: string | null; size: string
}

export function listModelHeads(root: string): Promise<ModelHead[]> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'scripts/run-model-service.mjs'), '--list-heads'],
      { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) { reject(new Error(`读取线性头失败：${error.message}`)); return }
        try { resolve(JSON.parse(stdout) as ModelHead[]) } catch { reject(new Error('线性头目录返回无效数据')) }
      })
  })
}

export function selectModelHead(heads: ModelHead[], id: string, task: string): ModelHead {
  const head = heads.find((item) => item.id === id)
  if (!head) throw new Error('所选线性头不存在，请刷新列表')
  if (!head.available) throw new Error(head.reason || '线性头不可用')
  if (head.task !== task) throw new Error('线性头与当前任务不匹配')
  if (!existsSync(head.stateFile) || head.loraCheckpoint && !existsSync(head.loraCheckpoint)) throw new Error('线性头或配套编码器文件已移除')
  return head
}

export function modelHeadArgs(head: ModelHead): string[] {
  return ['--state-file', head.stateFile, '--size', head.size,
    ...(head.loraCheckpoint ? ['--lora-checkpoint', head.loraCheckpoint] : ['--no-lora'])]
}
