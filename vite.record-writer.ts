import { operationGate } from './vite.operation-gate.ts'
/**
 * Vite plugin: stream a labeled session to recordings/<stem>/
 *
 *   recordings/<stem>/
 *     session.json
 *     eeg.bin + eeg.json + eeg.idx.json
 *     events.jsonl
 *     context.jsonl
 *
 *   POST /api/record/start
 *   GET  /api/record/active
 *   GET  /api/record/list
 *   GET  /api/record/library/:stem | /preview | /zip
 *   POST /api/record/library/:stem/meta
 *   DELETE /api/record/library/:stem
 *   POST /api/record/:id/chunk | events | context | meta | finish | abort
 */

import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'
import {
  STEM_RE as LIBRARY_STEM_RE,
  listSessionSummaries,
  patchSessionManifest,
  previewSession,
  summarizeSessionDir,
  zipSessionDir,
  type LiveOverlay,
} from './vite.record-library.ts'
import { onDevProcessExit } from './vite.process-hooks.ts'
import { saveNBackSnapshot } from './vite.nback-storage.ts'

const RECORD_DIR = 'recordings'
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
const MAX_SESSIONS = 2
const SESSION_SCHEMA = 'passive-bci.session.v1'

export function safeSessionStem(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? ''
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.bin$/i, '')
  return cleaned.slice(0, 80) || 'session'
}

export function safeRecordFilename(name: string): string {
  return `${safeSessionStem(name)}.bin`
}

type SessionManifest = {
  schema: string
  id: string
  dir: string
  startedAt: string
  stoppedAt?: string
  status: string
  files: {
    eeg: string
    eegMeta: string
    eegIndex: string
    events: string
    context: string
  }
  eeg: Record<string, unknown> | null
  experiment: string | null
  subjectId: string | null
  notes?: string
  game: Record<string, unknown> | null
  clock: Record<string, unknown> | null
  bytes?: number
}

interface RecordSession {
  id: string
  stem: string
  dirPath: string
  binPath: string
  metaPath: string
  sessionPath: string
  idxPath: string
  binStream: WriteStream
  eventsStream: WriteStream
  contextStream: WriteStream
  bytes: number
  queue: Promise<void>
  manifest: SessionManifest
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function asNdjson(buf: Buffer): Buffer {
  if (buf.byteLength === 0) return buf
  if (buf[buf.byteLength - 1] === 10) return buf
  return Buffer.concat([buf, Buffer.from('\n')])
}

function uniqueStem(root: string, stem: string): string {
  let name = stem
  let i = 2
  while (existsSync(join(root, name))) {
    name = `${stem}_${i++}`
  }
  return name
}

function writeManifest(session: RecordSession) {
  writeFileSync(session.sessionPath, `${JSON.stringify(session.manifest, null, 2)}\n`, 'utf8')
}

function writeEegSidecar(session: RecordSession, extra: Record<string, unknown>) {
  const payload = {
    ...(session.manifest.eeg ?? {}),
    filename: 'eeg.bin',
    bytes: session.bytes,
    ...extra,
  }
  writeFileSync(session.metaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve())
  })
}

export function recordWriterPlugin(): Plugin {
  const sessions = new Map<string, RecordSession>()
  let projectRoot = process.cwd()

  function recordingsDir(): string {
    return join(projectRoot, RECORD_DIR)
  }

  function liveOverlays(): Map<string, LiveOverlay> {
    const map = new Map<string, LiveOverlay>()
    for (const session of sessions.values()) {
      map.set(session.stem, {
        id: session.id,
        stem: session.stem,
        bytes: session.bytes,
        experiment: session.manifest.experiment,
        subjectId: session.manifest.subjectId,
      })
    }
    return map
  }

  async function closeSession(session: RecordSession, unlink: boolean) {
    sessions.delete(session.id)
    await session.queue.catch(() => undefined)
    await Promise.all([
      endStream(session.binStream),
      endStream(session.eventsStream),
      endStream(session.contextStream),
    ]).catch(() => undefined)
    operationGate.detachRecording(session.id)
    if (unlink) {
      try {
        rmSync(session.dirPath, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /** HMR / 未点停止会留下幽灵会话，下一轮采集会被 429 打回浏览器内存。 */
  async function evictOldestIfNeeded() {
    if (sessions.size < MAX_SESSIONS) return
    const oldest = sessions.values().next().value as RecordSession | undefined
    if (!oldest) return
    const keep = oldest.bytes > 0
    if (keep) {
      oldest.manifest.stoppedAt = new Date().toISOString()
      oldest.manifest.status = 'complete'
      oldest.manifest.bytes = oldest.bytes
      writeManifest(oldest)
      writeEegSidecar(oldest, {
        stoppedAt: oldest.manifest.stoppedAt,
        status: 'complete',
      })
    }
    console.log(
      `\x1b[32m[record]\x1b[0m evict ${oldest.stem} (${keep ? 'keep' : 'drop empty'})`,
    )
    await closeSession(oldest, !keep)
  }

  function closeAll() {
    for (const session of [...sessions.values()]) {
      void closeSession(session, false)
    }
  }

  let lastPaintLine = ''

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url === '/api/debug/paint') {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.end()
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, line: lastPaintLine || null })
        return
      }
      if (req.method === 'POST') {
        req.resume()
        res.statusCode = 204
        res.end()
        return
      }
    }
    if (!url.startsWith('/api/record')) {
      next()
      return
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.end()
      return
    }

    void (async () => {
      try {
        if (url === '/api/record/nback' && req.method === 'POST') {
          const buffer = await readBody(req)
          if (buffer.length > 2 * 1024 * 1024) {
            sendJson(res, 413, { ok: false, message: 'N-back 数据过大' })
            return
          }
          try {
            const rel = saveNBackSnapshot(recordingsDir(), JSON.parse(buffer.toString('utf8')))
            sendJson(res, 200, { ok: true, rel })
          } catch (error) {
            sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (url === '/api/record/active' && req.method === 'GET') {
          const session = [...sessions.values()].at(-1) ?? null
          if (!session) {
            sendJson(res, 200, { ok: true, id: null, rel: null })
            return
          }
          sendJson(res, 200, {
            ok: true,
            id: session.id,
            stem: session.stem,
            filename: 'eeg.bin',
            path: session.binPath,
            dir: session.dirPath,
            rel: `${RECORD_DIR}/${session.stem}`,
            bytes: session.bytes,
            startedAt: session.manifest.startedAt,
            experiment: session.manifest.experiment,
            subjectId: session.manifest.subjectId,
            status: session.manifest.status,
          })
          return
        }

        if (url === '/api/record/list' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, sessions: listSessionSummaries(recordingsDir(), liveOverlays()) })
          return
        }

        const library = url.match(/^\/api\/record\/library\/([^/]+)(?:\/(meta|zip|preview))?$/)
        if (library) {
          const stem = decodeURIComponent(library[1] ?? '')
          const action = library[2] ?? 'get'
          if (!LIBRARY_STEM_RE.test(stem)) {
            sendJson(res, 400, { ok: false, message: 'invalid stem' })
            return
          }
          const live = [...sessions.values()].find((s) => s.stem === stem)

          if (action === 'get' && req.method === 'GET') {
            const summary = summarizeSessionDir(recordingsDir(), stem, liveOverlays())
            if (!summary) {
              sendJson(res, 404, { ok: false, message: '会话不存在' })
              return
            }
            sendJson(res, 200, { ok: true, session: summary })
            return
          }

          if (action === 'preview' && req.method === 'GET') {
            const requestedTail = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('tail') ?? 24)
            const tail = Number.isInteger(requestedTail) && requestedTail > 0 ? Math.min(requestedTail, 10_000) : 24
            const preview = previewSession(recordingsDir(), stem, tail, liveOverlays())
            if (!preview) {
              sendJson(res, 404, { ok: false, message: '会话不存在' })
              return
            }
            sendJson(res, 200, { ok: true, ...preview })
            return
          }

          if (action === 'zip' && req.method === 'GET') {
            if (live) {
              sendJson(res, 409, { ok: false, message: '录制进行中，请先结束本局再下载' })
              return
            }
            const zip = zipSessionDir(recordingsDir(), stem)
            if (!zip) {
              sendJson(res, 404, { ok: false, message: '会话不存在或无可打包文件' })
              return
            }
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/zip')
            res.setHeader('Content-Disposition', `attachment; filename="${stem}.zip"`)
            res.setHeader('Content-Length', String(zip.length))
            res.setHeader('Cache-Control', 'no-store')
            res.end(zip)
            return
          }

          if (action === 'meta' && req.method === 'POST') {
            let patch: { notes?: string; subjectId?: string; experiment?: string } = {}
            try {
              const raw = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>
              if (typeof raw.notes === 'string') patch.notes = raw.notes.slice(0, 4000)
              if (typeof raw.subjectId === 'string') patch.subjectId = raw.subjectId.slice(0, 64)
              if (typeof raw.experiment === 'string') patch.experiment = raw.experiment.slice(0, 64)
            } catch {
              sendJson(res, 400, { ok: false, message: 'invalid json' })
              return
            }
            if (live) {
              if (patch.notes !== undefined) live.manifest.notes = patch.notes
              if (patch.subjectId !== undefined) live.manifest.subjectId = patch.subjectId
              if (patch.experiment !== undefined) live.manifest.experiment = patch.experiment
              writeManifest(live)
            }
            const summary = patchSessionManifest(recordingsDir(), stem, patch)
            if (!summary) {
              sendJson(res, 404, { ok: false, message: '会话不存在' })
              return
            }
            sendJson(res, 200, { ok: true, session: summary })
            return
          }

          if (action === 'get' && req.method === 'DELETE') {
            if (live) {
              sendJson(res, 409, { ok: false, message: '录制进行中，无法删除' })
              return
            }
            const dirPath = join(recordingsDir(), stem)
            if (!existsSync(dirPath)) {
              sendJson(res, 404, { ok: false, message: '会话不存在' })
              return
            }
            rmSync(dirPath, { recursive: true, force: true })
            sendJson(res, 200, { ok: true })
            return
          }

          sendJson(res, 405, { ok: false, message: 'method not allowed' })
          return
        }

        if (url === '/api/record/start' && req.method === 'POST') {
          try { operationGate.assertCanRecord() }
          catch (error) { sendJson(res, 409, { ok: false, message: String(error) }); return }
          await evictOldestIfNeeded()
          if (sessions.size >= MAX_SESSIONS) {
            sendJson(res, 429, { ok: false, message: '已有录制进行中' })
            return
          }
          let stem = `session_${Date.now()}`
          let eegMeta: Record<string, unknown> | null = null
          try {
            const raw = JSON.parse((await readBody(req)).toString('utf8')) as {
              filename?: string
              meta?: Record<string, unknown>
            }
            if (raw.filename) stem = safeSessionStem(raw.filename)
            if (raw.meta && typeof raw.meta === 'object') eegMeta = raw.meta
          } catch {
            stem = safeSessionStem(stem)
          }
          try { operationGate.assertCanRecord() }
          catch (error) { sendJson(res, 409, { ok: false, message: String(error) }); return }
          const root = recordingsDir()
          mkdirSync(root, { recursive: true })
          stem = uniqueStem(root, stem)
          const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
          const dirPath = join(root, stem)
          mkdirSync(dirPath, { recursive: true })
          const binPath = join(dirPath, 'eeg.bin')
          const session: RecordSession = {
            id,
            stem,
            dirPath,
            binPath,
            metaPath: join(dirPath, 'eeg.json'),
            sessionPath: join(dirPath, 'session.json'),
            idxPath: join(dirPath, 'eeg.idx.json'),
            binStream: createWriteStream(binPath, { flags: 'w' }),
            eventsStream: createWriteStream(join(dirPath, 'events.jsonl'), { flags: 'a' }),
            contextStream: createWriteStream(join(dirPath, 'context.jsonl'), { flags: 'a' }),
            bytes: 0,
            queue: Promise.resolve(),
            manifest: {
              schema: SESSION_SCHEMA,
              id,
              dir: stem,
              startedAt: new Date().toISOString(),
              status: 'recording',
              files: {
                eeg: 'eeg.bin',
                eegMeta: 'eeg.json',
                eegIndex: 'eeg.idx.json',
                events: 'events.jsonl',
                context: 'context.jsonl',
              },
              eeg: eegMeta,
              experiment: null,
              subjectId: null,
              notes: '',
              game: null,
              clock: {
                browser: 'performance.now',
                device: eegMeta?.device === 'neuracle' ? 'device_end_ms' : 'arrival',
              },
            },
          }
          operationGate.attachRecording(id)
          sessions.set(id, session)
          writeManifest(session)
          writeEegSidecar(session, { startedAt: session.manifest.startedAt, status: 'recording' })
          const rel = `${RECORD_DIR}/${stem}`
          console.log(`\x1b[32m[record]\x1b[0m start ${rel}/`)
          sendJson(res, 200, {
            ok: true,
            id,
            filename: 'eeg.bin',
            stem,
            path: binPath,
            dir: dirPath,
            rel,
          })
          return
        }

        const rest = url.match(
          /^\/api\/record\/([a-zA-Z0-9_-]+)\/(chunk|finish|abort|events|context|meta)$/,
        )
        if (!rest) {
          sendJson(res, 404, { ok: false, message: 'unknown record route' })
          return
        }
        const id = rest[1]!
        const action = rest[2]!
        if (!ID_RE.test(id)) {
          sendJson(res, 400, { ok: false, message: 'invalid id' })
          return
        }
        const session = sessions.get(id)
        if (!session) {
          sendJson(res, 404, { ok: false, message: '录制会话不存在' })
          return
        }

        if (action === 'chunk' && req.method === 'POST') {
          const buf = await readBody(req)
          session.queue = session.queue.then(
            () =>
              new Promise<void>((resolveWrite, rejectWrite) => {
                session.binStream.write(buf, (err) => {
                  if (err) rejectWrite(err)
                  else {
                    session.bytes += buf.byteLength
                    resolveWrite()
                  }
                })
              }),
          )
          await session.queue
          sendJson(res, 200, { ok: true, bytes: session.bytes })
          return
        }

        if ((action === 'events' || action === 'context') && req.method === 'POST') {
          const buf = asNdjson(await readBody(req))
          if (buf.byteLength === 0) {
            sendJson(res, 200, { ok: true })
            return
          }
          const stream = action === 'events' ? session.eventsStream : session.contextStream
          session.queue = session.queue.then(
            () =>
              new Promise<void>((resolveWrite, rejectWrite) => {
                stream.write(buf, (err) => (err ? rejectWrite(err) : resolveWrite()))
              }),
          )
          await session.queue
          sendJson(res, 200, { ok: true })
          return
        }

        if (action === 'meta' && req.method === 'POST') {
          try {
            const raw = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>
            if (typeof raw.experiment === 'string') session.manifest.experiment = raw.experiment
            if (typeof raw.subjectId === 'string') session.manifest.subjectId = raw.subjectId
            if (typeof raw.notes === 'string') session.manifest.notes = raw.notes.slice(0, 4000)
            const game = session.manifest.game ? { ...session.manifest.game } : {}
            if (typeof raw.game === 'string') game.name = raw.game
            if (typeof raw.seed === 'number' && Number.isFinite(raw.seed)) game.seed = raw.seed
            session.manifest.game = Object.keys(game).length ? game : session.manifest.game
          } catch {
            /* ignore malformed meta */
          }
          writeManifest(session)
          sendJson(res, 200, { ok: true })
          return
        }

        if (action === 'finish' && req.method === 'POST') {
          await session.queue.catch(() => undefined)
          const bytes = session.bytes
          const { stem, binPath, dirPath } = session
          let clock: unknown = null
          try {
            const raw = await readBody(req)
            if (raw.byteLength) {
              const parsed = JSON.parse(raw.toString('utf8')) as { clock?: unknown }
              clock = parsed.clock ?? null
            }
          } catch {
            clock = null
          }
          const clockSummary =
            clock && typeof clock === 'object'
              ? {
                  version: (clock as { version?: number }).version,
                  sampleRate: (clock as { sampleRate?: number }).sampleRate,
                  source: (clock as { source?: string }).source,
                  sampleIndex: (clock as { sampleIndex?: number }).sampleIndex,
                  minOffsetMs: (clock as { minOffsetMs?: number | null }).minOffsetMs ?? null,
                  batches: (clock as { batches?: unknown }).batches ? 'eeg.idx.json' : null,
                }
              : null
          writeEegSidecar(session, {
            stoppedAt: new Date().toISOString(),
            status: bytes === 0 ? 'empty' : 'complete',
            clock: clockSummary,
          })
          if (clock && bytes > 0) {
            writeFileSync(session.idxPath, `${JSON.stringify(clock)}\n`, 'utf8')
          }
          session.manifest.stoppedAt = new Date().toISOString()
          session.manifest.status = bytes === 0 ? 'empty' : 'complete'
          session.manifest.bytes = bytes
          session.manifest.clock = {
            ...(session.manifest.clock ?? {}),
            ...(clockSummary ?? {}),
          }
          writeManifest(session)
          await Promise.all([
            endStream(session.binStream),
            endStream(session.eventsStream),
            endStream(session.contextStream),
          ])
          sessions.delete(id)
          operationGate.detachRecording(id)
          if (bytes === 0) {
            try {
              rmSync(dirPath, { recursive: true, force: true })
            } catch {
              /* ignore */
            }
            sendJson(res, 200, { ok: true, bytes: 0, filename: 'eeg.bin', path: null, rel: null })
            return
          }
          const rel = `${RECORD_DIR}/${stem}`
          console.log(`\x1b[32m[record]\x1b[0m finish ${rel}/ (${bytes} bytes)`)
          sendJson(res, 200, {
            ok: true,
            bytes,
            filename: 'eeg.bin',
            stem,
            path: binPath,
            dir: dirPath,
            rel,
          })
          return
        }

        if (action === 'abort' && req.method === 'POST') {
          await closeSession(session, true)
          console.log(`\x1b[32m[record]\x1b[0m abort ${id}`)
          sendJson(res, 200, { ok: true })
          return
        }

        sendJson(res, 405, { ok: false, message: 'method not allowed' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendJson(res, 500, { ok: false, message })
      }
    })()
  }

  return {
    name: 'record-writer',
    configureServer(server) {
      projectRoot = server.config.root
      mkdirSync(join(projectRoot, RECORD_DIR), { recursive: true })
      server.middlewares.use(middleware)
      server.httpServer?.once('close', closeAll)
      onDevProcessExit('record-writer', closeAll)
      console.log(
        `\x1b[32m[record]\x1b[0m ready — 会话写入 ${join(projectRoot, RECORD_DIR)}/<stem>/`,
      )
    },
    configurePreviewServer(server) {
      projectRoot = server.config.root
      mkdirSync(join(projectRoot, RECORD_DIR), { recursive: true })
      server.middlewares.use(middleware)
    },
  }
}
