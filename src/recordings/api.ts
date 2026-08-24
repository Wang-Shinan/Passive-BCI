export type SessionStatus = 'recording' | 'complete' | 'empty' | 'interrupted'

export type SessionFileInfo = {
  name: string
  bytes: number
}

export type SessionSummary = {
  stem: string
  rel: string
  id: string | null
  live: boolean
  status: SessionStatus
  startedAt: string | null
  stoppedAt: string | null
  durationSec: number | null
  subjectId: string | null
  experiment: string | null
  device: string | null
  sampleRate: number | null
  channels: number | null
  notes: string
  game: Record<string, unknown> | null
  bytes: number
  eegBytes: number
  events: number
  contexts: number
  eventTypes: Record<string, number>
  files: SessionFileInfo[]
}

export type SessionPreview = {
  summary: SessionSummary
  events: unknown[]
  context: unknown[]
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json()) as T & { ok?: boolean; message?: string }
  if (!res.ok || body.ok === false) {
    throw new Error(body.message || `请求失败 (${res.status})`)
  }
  return body
}

export async function fetchSessionList(): Promise<SessionSummary[]> {
  const body = await readJson<{ sessions: SessionSummary[] }>('/api/record/list')
  return body.sessions ?? []
}

export async function fetchSessionPreview(stem: string): Promise<SessionPreview> {
  return readJson<SessionPreview>(`/api/record/library/${encodeURIComponent(stem)}/preview`)
}

export async function patchSessionMeta(
  stem: string,
  patch: { notes?: string; subjectId?: string; experiment?: string },
): Promise<SessionSummary> {
  const body = await readJson<{ session: SessionSummary }>(
    `/api/record/library/${encodeURIComponent(stem)}/meta`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  return body.session
}

export async function deleteSession(stem: string): Promise<void> {
  await readJson(`/api/record/library/${encodeURIComponent(stem)}`, { method: 'DELETE' })
}

export function sessionZipUrl(stem: string): string {
  return `/api/record/library/${encodeURIComponent(stem)}/zip`
}
