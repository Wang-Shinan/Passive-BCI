import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import {
  DEFAULT_OMNI_GUI_PORT, OMNI_GUI_PORT_CANDIDATES, OMNI_GUI_PROXY_PATH,
  omniGuiOrigin, parseOmniGuiPort,
} from './src/acquisition/omni/guiEndpoint.js'

type GuiStatus = {
  schema?: number
  schema_version?: number
  api_control_enabled: boolean
  connected: boolean
  streaming: boolean
}

function isGuiStatus(value: unknown): value is GuiStatus {
  const status = value as Partial<GuiStatus> | null
  return (status?.schema_version ?? status?.schema) === 1 &&
    typeof status?.api_control_enabled === 'boolean' &&
    typeof status.connected === 'boolean' && typeof status.streaming === 'boolean'
}

function reply(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

async function triggerBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 16 * 1024) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function omniGuiPlugin(): Plugin {
  return {
    name: 'omni-gui-http',
    configureServer(server) {
      const confirmed = new Map<number, number>()
      const probe = async (port: number, timeoutMs = 1500) => {
        try {
          const response = await fetch(`${omniGuiOrigin(port)}/v1/status`, {
            redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          })
          const status: unknown = response.ok ? await response.json() : null
          if (isGuiStatus(status)) {
            confirmed.set(port, Date.now())
            return { port, status }
          }
        } catch { /* A closed port, timeout, or other HTTP service is not a candidate. */ }
        confirmed.delete(port)
        return null
      }

      server.middlewares.use(OMNI_GUI_PROXY_PATH, async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/discover' && req.method === 'GET') {
          const value = url.searchParams.get('port')
          const manual = value === null ? null : parseOmniGuiPort(value)
          if (value !== null && manual === null) return reply(res, 400, { error: 'Invalid GUI port' })
          const ports = manual === null ? OMNI_GUI_PORT_CANDIDATES : [manual]
          const found = (await Promise.all(ports.map(port => probe(port, manual === null ? undefined : 4000))))
            .filter(result => result !== null)
          const preferred = found.find(({ status }) => status.api_control_enabled && status.connected && status.streaming) ??
            found.find(({ status }) => status.api_control_enabled) ?? found[0]
          return preferred ? reply(res, 200, { port: preferred.port }) : reply(res, 404, { error: 'OmniBCI GUI not found' })
        }

        const route = /^\/(?:(\d{1,5})\/)?v1\/(status|data|trigger)$/.exec(url.pathname)
        if (!route) return reply(res, 404, { error: 'Unknown OmniBCI GUI endpoint' })
        const port = route[1] === undefined ? DEFAULT_OMNI_GUI_PORT : parseOmniGuiPort(route[1])
        if (port === null) return reply(res, 400, { error: 'Invalid GUI port' })
        const endpoint = route[2]
        const trigger = endpoint === 'trigger'
        if (req.method !== (trigger ? 'POST' : 'GET')) return reply(res, 405, { error: 'Method not allowed' })
        if (trigger && (req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') {
          return reply(res, 415, { error: 'Expected a JSON trigger' })
        }

        const client = new AbortController()
        const cancel = () => client.abort()
        res.once('close', cancel)
        try {
          if (endpoint !== 'status' && Date.now() - (confirmed.get(port) ?? 0) > 5000 && !await probe(port)) {
            return reply(res, 502, { error: 'OmniBCI GUI not reachable' })
          }
          const body = trigger ? await triggerBody(req) : undefined
          if (body === null) return reply(res, 413, { error: 'GUI trigger body too large' })
          const upstream = await fetch(`${omniGuiOrigin(port)}/v1/${endpoint}${url.search}`, {
            method: req.method, redirect: 'error', body,
            ...(trigger ? { headers: { 'Content-Type': 'application/json' } } : {}),
            signal: AbortSignal.any([client.signal, AbortSignal.timeout(5000)]),
          })
          const data = Buffer.from(await upstream.arrayBuffer())
          if (endpoint === 'status') {
            const status: unknown = upstream.ok ? JSON.parse(data.toString('utf8')) : null
            if (isGuiStatus(status)) confirmed.set(port, Date.now())
            else {
              confirmed.delete(port)
              return reply(res, upstream.ok ? 502 : upstream.status, { error: 'OmniBCI GUI status unavailable' })
            }
          }
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end(data)
        } catch {
          if (endpoint === 'status') confirmed.delete(port)
          if (!res.destroyed) reply(res, 502, { error: 'OmniBCI GUI not reachable' })
        } finally {
          res.off('close', cancel)
        }
      })
    },
  }
}
