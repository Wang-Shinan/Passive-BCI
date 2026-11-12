import { recorderIsActive, startExperimentRecording } from '../../lib/session/recordControl'
import type { RecordControlResult } from '../../lib/session/recordControl'

/**
 * Attached vs owned: attaching binds focus labels to whatever recording is
 * current, but only a recorder this session started is owned — owned sessions
 * get stopped/saved on finish; a reused recorder keeps running for its owner.
 */
export type RecordingAttachment = RecordControlResult & {
  /** events may be logged into the current recording */
  attached: boolean
  /** this session started the recorder and must stop/save it */
  owns: boolean
}

export async function attachFocusRecording(subjectId: string, seed: number): Promise<RecordingAttachment> {
  // Snapshot synchronously before the await: a recorder that starts between the
  // check and the call would otherwise be misattributed as ours.
  const wasActive = recorderIsActive()
  const result = await startExperimentRecording({ experiment: 'focus', subjectId, seed })
  return {
    ...result,
    owns: !!result.ok && !wasActive,
    attached: !!result.ok && result.sink === 'disk' && !!result.rel,
  }
}
