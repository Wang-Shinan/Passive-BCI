import type { Plugin } from 'vite'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function clientDiagnosticsPlugin(): Plugin {
  return { name: 'client-diagnostics', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/api/client-diagnostics' || req.method !== 'POST') return next()
      let body = ''; let oversized = false
      req.on('data', chunk => {
        if (oversized) return
        body += chunk.toString()
        if (body.length > 16000) { oversized = true; body = '' }
      })
      req.on('end', () => {
        try {
          if (oversized) { res.statusCode = 413; res.end(); return }
          const data = JSON.parse(body)
          const dir = join(server.config.root, 'recordings', '.diagnostics')
          mkdirSync(dir, { recursive: true })
          const file = join(dir, 'client.jsonl')
          if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) {
            rmSync(file + '.previous', { force: true }); renameSync(file, file + '.previous')
          }
          appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), data }) + '\n')
          res.statusCode = 204; res.end()
        } catch { res.statusCode = 400; res.end() }
      })
    })
  } }
}
