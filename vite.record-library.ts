import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipStoreBuffers } from './vite.record-zip.ts'

export const SESSION_SCHEMA = 'passive-bci.session.v1'
export const STEM_RE = /^[a-zA-Z0-9._-]{1,80}$/
export const SESSION_FILES = [
  'behavior.json',
  'session.json',
  'eeg.bin',
  'eeg.json',
  'eeg.idx.json',
  'events.jsonl',
  'context.jsonl',
] as const

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

export type LiveOverlay = {
  id: string
  stem: string
  bytes: number
  experiment: string | null
  subjectId: string | null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function countNdjsonLines(buf: Buffer): number {
  if (!buf.byteLength) return 0
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
  if (buf[buf.length - 1] !== 10) n++
  return n
}

export function eventTypeHistogram(buf: Buffer, limitBytes = 8 * 1024 * 1024): Record<string, number> {
  const counts: Record<string, number> = {}
  if (!buf.byteLength || buf.byteLength > limitBytes) return counts
  const text = buf.toString('utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown }
      if (typeof parsed.type === 'string' && parsed.type) {
        counts[parsed.type] = (counts[parsed.type] ?? 0) + 1
      }
    } catch {
      /* skip malformed */
    }
  }
  return counts
}

export function tailNdjson(buf: Buffer, n: number): unknown[] {
  if (!buf.byteLength || n <= 0) return []
  const text = buf.toString('utf8')
  const lines = text.split('\n').filter((line) => line.trim())
  const slice = lines.slice(-n)
  const out: unknown[] = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line))
    } catch {
      out.push({ raw: line.slice(0, 400) })
    }
  }
  return out
}

export function estimateDurationSec(
  eeg: Record<string, unknown> | null,
  eegBytes: number,
  startedAt: string | null,
  stoppedAt: string | null,
): number | null {
  if (startedAt && stoppedAt) {
    const a = Date.parse(startedAt)
    const b = Date.parse(stoppedAt)
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return (b - a) / 1000
  }
  if (!eeg || eegBytes <= 0) return null
  const sr = Number(eeg.sampleRate)
  const ch = Number(eeg.channels)
  const format = String(eeg.format ?? '')
  if (format === 'ads1299-frame') {
    const frameBytes = Number(eeg.frameBytes) || 48
    if (sr > 0 && frameBytes > 0) return eegBytes / frameBytes / sr
  }
  if (sr > 0 && ch > 0) return eegBytes / (4 * ch * sr)
  return null
}

function fileStat(dirPath: string, name: string): SessionFileInfo | null {
  const path = join(dirPath, name)
  if (!existsSync(path)) return null
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    return { name, bytes: st.size }
  } catch {
    return null
  }
}

export function summarizeSessionDir(
  recordingsRoot: string,
  stem: string,
  liveByStem: Map<string, LiveOverlay> = new Map(),
): SessionSummary | null {
  if (!STEM_RE.test(stem)) return null
  const dirPath = join(recordingsRoot, stem)
  if (!existsSync(dirPath)) return null
  try {
    if (!statSync(dirPath).isDirectory()) return null
  } catch {
    return null
  }

  const manifest = readJson(join(dirPath, 'session.json'))
  const eegMeta = readJson(join(dirPath, 'eeg.json'))
  const eeg = (manifest?.eeg as Record<string, unknown> | undefined) ?? eegMeta
  const files = SESSION_FILES.map((name) => fileStat(dirPath, name)).filter(
    (f): f is SessionFileInfo => f !== null,
  )
  const eegFile = files.find((f) => f.name === 'eeg.bin')
  const eventsFile = join(dirPath, 'events.jsonl')
  const contextFile = join(dirPath, 'context.jsonl')
  const eventsBuf = existsSync(eventsFile) ? readFileSync(eventsFile) : Buffer.alloc(0)
  const contextBuf = existsSync(contextFile) ? readFileSync(contextFile) : Buffer.alloc(0)
  const live = liveByStem.get(stem) ?? null
  const id = live?.id ?? asString(manifest?.id)
  const startedAt = asString(manifest?.startedAt)
  const stoppedAt = asString(manifest?.stoppedAt)
  let status = (asString(manifest?.status) as SessionStatus | null) ?? 'complete'
  if (live) status = 'recording'
  else if (status === 'recording') status = 'interrupted'
  const eegBytes = live?.bytes ?? eegFile?.bytes ?? 0
  const bytes = files.reduce((sum, f) => sum + (f.name === 'eeg.bin' ? eegBytes : f.bytes), 0)

  return {
    stem,
    rel: `recordings/${stem}`,
    id,
    live: Boolean(live),
    status,
    startedAt,
    stoppedAt: live ? null : stoppedAt,
    durationSec: estimateDurationSec(eeg ?? null, eegBytes, startedAt, live ? null : stoppedAt),
    subjectId: live?.subjectId ?? asString(manifest?.subjectId),
    experiment: live?.experiment ?? asString(manifest?.experiment),
    device: asString(eeg?.device),
    sampleRate: asNumber(eeg?.sampleRate),
    channels: asNumber(eeg?.channels),
    notes: asString(manifest?.notes) ?? '',
    game: manifest?.game && typeof manifest.game === 'object' ? (manifest.game as Record<string, unknown>) : null,
    bytes,
    eegBytes,
    events: countNdjsonLines(eventsBuf),
    contexts: countNdjsonLines(contextBuf),
    eventTypes: eventTypeHistogram(eventsBuf),
    files,
  }
}

export function listSessionSummaries(
  recordingsRoot: string,
  liveByStem: Map<string, LiveOverlay> = new Map(),
): SessionSummary[] {
  if (!existsSync(recordingsRoot)) return []
  const names = readdirSync(recordingsRoot)
  const out: SessionSummary[] = []
  for (const name of names) {
    const summary = summarizeSessionDir(recordingsRoot, name, liveByStem)
    if (summary) out.push(summary)
  }
  out.sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : 0
    const tb = b.startedAt ? Date.parse(b.startedAt) : 0
    return tb - ta
  })
  return out
}

export function patchSessionManifest(
  recordingsRoot: string,
  stem: string,
  patch: { notes?: string; subjectId?: string; experiment?: string },
): SessionSummary | null {
  const dirPath = join(recordingsRoot, stem)
  const sessionPath = join(dirPath, 'session.json')
  const current = readJson(sessionPath) ?? {
    schema: SESSION_SCHEMA,
    id: null,
    dir: stem,
    status: 'complete',
  }
  if (patch.notes !== undefined) current.notes = patch.notes
  if (patch.subjectId !== undefined) current.subjectId = patch.subjectId
  if (patch.experiment !== undefined) current.experiment = patch.experiment
  writeFileSync(sessionPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  return summarizeSessionDir(recordingsRoot, stem)
}

export function zipSessionDir(recordingsRoot: string, stem: string): Buffer | null {
  const dirPath = join(recordingsRoot, stem)
  if (!existsSync(dirPath) || !STEM_RE.test(stem)) return null
  const files = []
  for (const name of SESSION_FILES) {
    const path = join(dirPath, name)
    if (!existsSync(path)) continue
    const st = statSync(path)
    if (!st.isFile()) continue
    files.push({ name, data: readFileSync(path), mtime: st.mtime })
  }
  if (!files.length) return null
  return zipStoreBuffers(files)
}

export function previewSession(
  recordingsRoot: string,
  stem: string,
  tail = 20,
  liveByStem: Map<string, LiveOverlay> = new Map(),
): {
  summary: SessionSummary
  events: unknown[]
  context: unknown[]
} | null {
  const summary = summarizeSessionDir(recordingsRoot, stem, liveByStem)
  if (!summary) return null
  const eventsPath = join(recordingsRoot, stem, 'events.jsonl')
  const contextPath = join(recordingsRoot, stem, 'context.jsonl')
  return {
    summary,
    events: existsSync(eventsPath) ? tailNdjson(readFileSync(eventsPath), tail) : [],
    context: existsSync(contextPath) ? tailNdjson(readFileSync(contextPath), Math.min(8, tail)) : [],
  }
}
