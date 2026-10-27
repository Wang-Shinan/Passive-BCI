import { persistentDevStore } from './vite.process-hooks.ts'

/** Serialize model operations across tabs; recording proceeds independently. */
export class OperationGate {
  private changing = false
  beginModelChange(): () => void {
    if (this.changing) throw new Error('另一项模型操作正在进行')
    this.changing = true
    let released = false
    return () => { if (!released) { released = true; this.changing = false } }
  }
}
export const operationGate = persistentDevStore('record-model-operation-gate', () => new OperationGate())
