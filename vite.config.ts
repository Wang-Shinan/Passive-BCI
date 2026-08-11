import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect } from 'vite'

const MAX_LOG_CHARS = 2400

function maskSecret(value: string | undefined): string {
  if (!value) return '(none)'
  const raw = value.replace(/^Bearer\s+/i, '')
  if (raw.length <= 10) return '***'
  return `${raw.slice(0, 6)}…${raw.slice(-4)} (len=${raw.length})`
}

function truncate(text: string, max = MAX_LOG_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
}

/** Strip huge data-URL images so terminal stays readable. */
function summarizeBody(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      model?: string
      messages?: Array<{
        role?: string
        content?: unknown
      }>
    }
    const summary = {
      model: parsed.model,
      messages: (parsed.messages ?? []).map((msg) => {
        if (!Array.isArray(msg.content)) {
          return { role: msg.role, content: msg.content }
        }
        return {
          role: msg.role,
          content: msg.content.map((part) => {
            if (!part || typeof part !== 'object') return part
            const p = part as { type?: string; text?: string; image_url?: { url?: string } }
            if (p.type === 'image_url') {
              const url = p.image_url?.url ?? ''
              return {
                type: 'image_url',
                image_url: {
                  url: url.startsWith('data:')
                    ? `[data-url ${url.length} chars, ${url.slice(0, 32)}…]`
                    : url,
                },
              }
            }
            if (p.type === 'text') {
              return { type: 'text', text: truncate(p.text ?? '', 500) }
            }
            return p
          }),
        }
      }),
    }
    return JSON.stringify(summary, null, 2)
  } catch {
    return truncate(raw)
  }
}

function logBlock(title: string, lines: string[]) {
  const bar = '─'.repeat(56)
  console.log(`\n\x1b[36m[llm-proxy]\x1b[0m ${title}`)
  console.log(bar)
  for (const line of lines) console.log(line)
  console.log(bar)
}

/**
 * Same-origin proxy so the browser can call OpenAI-compatible Vision APIs
 * without CORS. Client POSTs to /api/llm with header X-Proxy-Target = real URL.
 */
function llmProxyPlugin(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/llm')) {
      next()
      return
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Proxy-Target')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.end()
      return
    }
    if (req.method !== 'POST') {
      next()
      return
    }
    void proxyLlm(req, res)
  }

  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use(middleware)
      console.log('\x1b[36m[llm-proxy]\x1b[0m ready — POST /api/llm will print request/response here')
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message]
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause instanceof Error) {
    parts.push(`cause=${cause.name}: ${cause.message}`)
    const code = (cause as NodeJS.ErrnoException).code
    if (code) parts.push(`code=${code}`)
  } else if (cause && typeof cause === 'object') {
    parts.push(`cause=${JSON.stringify(cause)}`)
  }
  return parts.join(' | ')
}

async function fetchUpstreamWithRetry(
  target: string,
  headers: Record<string, string>,
  body: Buffer,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 90_000)
      try {
        return await fetch(target, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      lastError = error
      logBlock(`UPSTREAM FETCH RETRY ${i}/${attempts}`, [
        formatFetchError(error),
        i < attempts ? 'retrying in 800ms…' : 'giving up',
      ])
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function proxyLlm(req: IncomingMessage, res: ServerResponse) {
  const started = Date.now()
  try {
    const target = String(req.headers['x-proxy-target'] ?? '').trim()
    if (!/^https?:\/\//i.test(target)) {
      logBlock('REJECTED', [
        `reason: Missing or invalid X-Proxy-Target`,
        `got: ${JSON.stringify(req.headers['x-proxy-target'] ?? null)}`,
      ])
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Missing or invalid X-Proxy-Target' }))
      return
    }

    const body = await readBody(req)
    const bodyText = body.toString('utf8')
    let auth = req.headers.authorization
    if (typeof auth === 'string') {
      // Normalize "Bearer Bearer sk-…" / whitespace from client paste.
      const token = auth.replace(/^Bearer\s+/i, '').trim().replace(/\s+/g, '')
      auth = token ? `Bearer ${token}` : ''
    }

    logBlock('REQUEST → upstream', [
      `time: ${new Date().toISOString()}`,
      `target: ${target}`,
      `authorization: ${maskSecret(typeof auth === 'string' ? auth : undefined)}`,
      `body-bytes: ${body.byteLength}`,
      `body:`,
      summarizeBody(bodyText),
    ])

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Passive-BCI-DrawGuess/1.0',
    }
    if (typeof auth === 'string' && auth) headers.Authorization = auth

    if (target.includes('api.kimi.com')) {
      logBlock('NOTE', [
        'Upstream is Kimi Coding Plan (api.kimi.com).',
        '401 → key 无效/过期，或误用了开放平台 moonshot key（两边不互通）。',
        'fetch failed / SSL → 到 api.kimi.com 的链路不稳定，代理会自动重试。',
        'Models: k3 (vision) | k3-256k | kimi-for-coding | kimi-for-coding-highspeed',
      ])
    }

    let wantsStream = false
    try {
      wantsStream = Boolean((JSON.parse(bodyText) as { stream?: boolean }).stream)
    } catch {
      wantsStream = false
    }

    const upstream = await fetchUpstreamWithRetry(target, headers, body)
    const contentType = upstream.headers.get('content-type') ?? 'application/json'
    const ok = upstream.status >= 200 && upstream.status < 300

    // Stream SSE through to the browser (token-by-token). Do not buffer.
    if (wantsStream && ok && upstream.body) {
      const msHeaders = Date.now() - started
      logBlock('RESPONSE ← upstream STREAM', [
        `status: ${upstream.status} ${upstream.statusText}`,
        `ttfb: ${msHeaders} ms`,
        `content-type: ${contentType}`,
      ])

      res.statusCode = upstream.status
      res.setHeader(
        'Content-Type',
        contentType.includes('event-stream') ? contentType : 'text/event-stream; charset=utf-8',
      )
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      if (typeof (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders === 'function') {
        ;(res as ServerResponse & { flushHeaders: () => void }).flushHeaders()
      }

      const reader = upstream.body.getReader()
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          res.write(Buffer.from(value))
        }
        res.end()
        logBlock('STREAM END', [
          `bytes: ${bytes}`,
          `total-latency: ${Date.now() - started} ms`,
        ])
      } catch (streamError) {
        logBlock('STREAM ERROR', [formatFetchError(streamError)])
        if (!res.writableEnded) res.end()
      }
      return
    }

    const text = await upstream.text()
    const ms = Date.now() - started

    logBlock(ok ? 'RESPONSE ← upstream OK' : 'RESPONSE ← upstream ERROR', [
      `status: ${upstream.status} ${upstream.statusText}`,
      `latency: ${ms} ms`,
      `content-type: ${contentType}`,
      `body-chars: ${text.length}`,
      `body:`,
      truncate(text),
    ])

    res.statusCode = upstream.status
    res.setHeader('Content-Type', contentType)
    res.end(text)
  } catch (error) {
    const ms = Date.now() - started
    const message = formatFetchError(error)
    logBlock('PROXY EXCEPTION', [
      `latency: ${ms} ms`,
      `error: ${message}`,
      error instanceof Error && error.stack ? `stack:\n${error.stack}` : '',
    ].filter(Boolean))
    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        error: message,
        hint: 'api.kimi.com TLS/网络失败时请重试；401 请核对 Kimi Code Console 的 key（不是 moonshot.cn 开放平台 key）',
      }),
    )
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), llmProxyPlugin()],
  server: {
    proxy: {
      // Neuracle bridge (bridges/neuracle/ws_bridge.py) — JellyFish TCP → WS
      '/ws/neuracle': {
        target: 'ws://127.0.0.1:8766',
        ws: true,
        rewrite: (path) => path.replace(/^\/ws\/neuracle/, '/v1/stream'),
      },
    },
  },
})
