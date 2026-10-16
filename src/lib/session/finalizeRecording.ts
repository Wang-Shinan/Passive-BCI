import { recorderIsActive, stopExperimentRecording } from './recordControl'
import { sessionHub } from './sessionHub'

let pending: Promise<void> | null = null

/**
 * Save whichever EEG recording currently owns the server lock before a task
 * reconnects or changes its model. A recording owned by this page can be
 * completed with its clock metadata; a recording left by another page is kept
 * as an interrupted session because this page cannot flush that page's tail.
 */
export function finalizeActiveRecording(): Promise<void> {
  if (!pending) pending = saveRecording().finally(() => { pending = null })
  return pending
}

async function activeRecordingId(): Promise<string | null> {
  const response = await fetch('/api/record/active')
  if (!response.ok) throw new Error('无法确认录制状态，尚未切换模型。')
  const active = await response.json() as { ok?: boolean; id?: string | null }
  if (!active.ok) throw new Error('无法确认录制状态，尚未切换模型。')
  return active.id ?? null
}

async function saveRecording(): Promise<void> {
  if (recorderIsActive()) {
    const saved = await stopExperimentRecording()
    if (!saved.ok) throw new Error(saved.message)
  }
  await sessionHub.flush()

  const id = await activeRecordingId()
  if (id) {
    const response = await fetch(`/api/record/${encodeURIComponent(id)}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incomplete: true }),
    })
    // The recording writer returns 409 after successfully retaining an
    // incomplete segment. Other failures mean its model lock may still exist.
    if (!response.ok && response.status !== 409) {
      throw new Error('录制保存未完成，尚未切换模型。')
    }
  }

  if (await activeRecordingId()) throw new Error('仍有进行中的录制，尚未切换模型。')
  sessionHub.detach()
}
