import { recorderIsActive, startExperimentRecording } from '../../lib/session/recordControl'
import type { RecordControlResult } from '../../lib/session/recordControl'

export type RecordingAttachment = RecordControlResult & {
  attached: boolean
  owns: boolean
}

export async function attachJawRecording(subjectId: string, seed: number, allowReuse: boolean): Promise<RecordingAttachment> {
  const wasActive = recorderIsActive()
  if (wasActive && !allowReuse) {
    return {
      ok: false,
      message: '已有录制正在进行，请先在采集页保存并结束当前录制',
      attached: false,
      owns: false,
    }
  }
  const result = await startExperimentRecording({ experiment: 'jaw-clench', subjectId, seed })
  return {
    ...result,
    owns: !!result.ok && !wasActive,
    attached: !!result.ok && result.sink === 'disk' && !!result.rel,
  }
}
