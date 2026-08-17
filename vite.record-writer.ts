/**
 * Vite plugin: stream EEG recordings to recordings/ so the browser
 * does not hold the whole session in RAM.
 *
 *   POST /api/record/start
 *   POST /api/record/:id/chunk
 *   POST /api/record/:id/finish
 *   POST /api/record/:id/abort
 */

import type { Connect, Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWriteStream, mkdirSync, unlinkSync, writeFileSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

const RECORD_DIR = 'recordings'
const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
const MAX_SESSIONS = 2

export function safeRecordFilename(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? ''
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '')
  if (!cleaned) return 'session.bin'
  return cleaned.endsWith('.bin') ? cleaned.slice(0, 120) : `${cleaned.slice(0, 116)}.bin`
}

interface RecordSession {
  id: string
  filename: string
  binPath: string
  metaPath: string
  stream: WriteStream
  bytes: number
  queue: Promise<void>
  meta: Record<string, unknown> | null
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

function writeSidecar(session: RecordSession, extra: Record<string, unknown>) {
  const payload = {
    ...(session.meta ?? {}),
    filename: session.filename,
    bytes: session.bytes,
    ...extra,
  }
  writeFileSync(session.metaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export function recordWriterPlugin(): Plugin {
  const sessions = new Map<string, RecordSession>()
  let projectRoot = process.cwd()

  function recordingsDir(): string {
    return join(projectRoot, RECORD_DIR)
  }

  function closeSession(session: RecordSession, unlink: boolean) {
    sessions.delete(session.id)
    try {
      session.stream.end()
    } catch {
      /* ignore */
    }
    if (unlink) {
      try {
        unlinkSync(session.binPath)
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(session.metaPath)
      } catch {
        /* ignore */
      }
    }
  }

  function closeAll() {
    for (const session of [...sessions.values()]) closeSession(session, false)
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (!url.startsWith('/api/record')) {
      next()
      return
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.end()
      return
    }

    void (async () => {
      try {
        if (url === '/api/record/start' && req.method === 'POST') {
          if (sessions.size >= MAX_SESSIONS) {
            sendJson(res, 429, { ok: false, message: '已有录制进行中' })
            return
          }
          let filename = `session_${Date.now()}.bin`
          let meta: Record<string, unknown> | null = null
          try {
            const raw = JSON.parse((await readBody(req)).toString('utf8')) as {
              filename?: string
              meta?: Record<string, unknown>
            }
            if (raw.filename) filename = safeRecordFilename(raw.filename)
            if (raw.meta && typeof raw.meta === 'object') meta = raw.meta
          } catch {
            filename = safeRecordFilename(filename)
          }
          mkdirSync(recordingsDir(), { recursive: true })
          const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
          const binPath = join(recordingsDir(), filename)
          const stream = createWriteStream(binPath, { flags: 'w' })
          const session: RecordSession = {
            id,
            filename,
            binPath,
            metaPath: binPath.replace(/\.bin$/i, '.json'),
            stream,
            bytes: 0,
            queue: Promise.resolve(),
            meta,
          }
          sessions.set(id, session)
          writeSidecar(session, { startedAt: new Date().toISOString(), status: 'recording' })
          const rel = `${RECORD_DIR}/${filename}`
          console.log(`\x1b[32m[record]\x1b[0m start ${rel}`)
          sendJson(res, 200, { ok: true, id, filename, path: binPath, rel })
          return
        }

        const rest = url.match(/^\/api\/record\/([a-zA-Z0-9_-]+)\/(chunk|finish|abort)$/)
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
                session.stream.write(buf, (err) => {
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

        if (action === 'finish' && req.method === 'POST') {
          await session.queue.catch(() => undefined)
          const bytes = session.bytes
          const { filename, binPath } = session
          writeSidecar(session, {
            stoppedAt: new Date().toISOString(),
            status: bytes === 0 ? 'empty' : 'complete',
          })
          await new Promise<void>((resolveClose) => {
            session.stream.end(() => resolveClose())
          })
          sessions.delete(id)
          if (bytes === 0) {
            try {
              unlinkSync(binPath)
            } catch {
              /* ignore */
            }
            try {
              unlinkSync(session.metaPath)
            } catch {
              /* ignore */
            }
            sendJson(res, 200, { ok: true, bytes: 0, filename, path: null, rel: null })
            return
          }
          const rel = `${RECORD_DIR}/${filename}`
          console.log(`\x1b[32m[record]\x1b[0m finish ${rel} (${bytes} bytes)`)
          sendJson(res, 200, { ok: true, bytes, filename, path: binPath, rel })
          return
        }

        if (action === 'abort' && req.method === 'POST') {
          await session.queue.catch(() => undefined)
          closeSession(session, true)
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
      process.once('exit', closeAll)
      console.log(
        `\x1b[32m[record]\x1b[0m ready — EEG 写入 ${join(projectRoot, RECORD_DIR)}/`,
      )
    },
    configurePreviewServer(server) {
      projectRoot = server.config.root
      mkdirSync(join(projectRoot, RECORD_DIR), { recursive: true })
      server.middlewares.use(middleware)
    },
  }
}
