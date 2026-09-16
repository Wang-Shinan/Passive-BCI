import { persistentDevStore } from './vite.process-hooks.ts'

/** Shared by all tabs and Vite middleware in this process. Emergency stop is never blocked. */
export class OperationGate {
  private recordings = new Set<string>()
  private changing = false
  assertCanRecord(): void {
    if (this.changing) throw new Error('模型正在切换或训练，暂不能开始录制')
  }
  attachRecording(id: string): void { this.assertCanRecord(); this.recordings.add(id) }
  detachRecording(id: string): void { this.recordings.delete(id) }
  beginModelChange(): () => void {
    if (this.recordings.size) throw new Error('录制期间禁止替换或训练模型，请先结束录制')
    if (this.changing) throw new Error('另一项模型操作正在进行')
    this.changing = true
    let released = false
    return () => { if (!released) { released = true; this.changing = false } }
  }
}
export const operationGate = persistentDevStore('record-model-operation-gate', () => new OperationGate())
