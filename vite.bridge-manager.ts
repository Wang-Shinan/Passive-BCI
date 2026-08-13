/**
 * Vite plugin: one-click start/stop for local acquisition bridges
 * (BCIGo / Neuracle) so the browser GUI need not ask users to run npm scripts.
 *
 *   POST /api/bridge/:name/ensure
 *   GET  /api/bridge/:name/status
 *   POST /api/bridge/:name/stop
 */

import type { Plugin } from 'vite'
import type { Connect } from 'vite'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'

type BridgeName = 'bcigo' | 'neuracle'

interface BridgeSpec {
  name: BridgeName
  port: number
  script: string
  readyPattern: RegExp
  buildEnv: (root: string) => NodeJS.ProcessEnv
  resolvePython: (root: string) => string
}

interface ManagedBridge {
  child: ChildProcess | null
  /** true if we spawned it (vs already listening externally) */
  owned: boolean
  lastError: string
  starting: Promise<EnsureResult> | null
}

interface EnsureResult {
  ok: boolean
  name: BridgeName
  port: number
  running: boolean
  owned: boolean
  pid: number | null
  alreadyRunning: boolean
  message?: string
}

const SPECS: Record<BridgeName, BridgeSpec> = {
  bcigo: {
    name: 'bcigo',
    port: 8767,
    script: 'bridges/bcigo/ws_bridge.py',
    readyPattern: /\[bcigo-bridge\].*waiting/i,
    buildEnv: (root) => ({ ...process.env, PYTHONUNBUFFERED: '1' }),
    resolvePython: () => process.env.BCIGO_PYTHON || 'python3',
  },
  neuracle: {
    name: 'neuracle',
    port: 8766,
    script: 'bridges/neuracle/ws_bridge.py',
    readyPattern: /\[neuracle-bridge\].*waiting/i,
    buildEnv: (root) => {
      const oi =
        process.env.OI_MI_ROOT ||
        path.join(os.homedir(), 'Documents', 'oi-mi')
      return { ...process.env, PYTHONUNBUFFERED: '1', OI_MI_ROOT: oi }
    },
    resolvePython: (root) => {
      const oi =
        process.env.OI_MI_ROOT ||
        path.join(os.homedir(), 'Documents', 'oi-mi')
      const venvPy = path.join(oi, '.venv', 'bin', 'python')
      if (existsSync(venvPy)) return venvPy
      return process.env.NEURACLE_PYTHON || 'python3'
    },
  },
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  // Avoid raw TCP connect against a WebSocket server — that triggers noisy
  // websockets.InvalidMessage logs. Use a bind probe instead: if we can bind
  // the port, nothing is listening; if EADDRINUSE, something is.
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE')
    })
    server.once('listening', () => {
      server.close(() => resolve(false))
    })
    try {
      server.listen(port, host)
    } catch {
      resolve(false)
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function bridgeManagerPlugin(): Plugin {
  const managed: Record<BridgeName, ManagedBridge> = {
    bcigo: { child: null, owned: false, lastError: '', starting: null },
    neuracle: { child: null, owned: false, lastError: '', starting: null },
  }
  let projectRoot = process.cwd()

  async function statusOf(name: BridgeName): Promise<EnsureResult> {
    const spec = SPECS[name]
    const state = managed[name]
    const listening = await isPortOpen(spec.port)
    const alive = Boolean(state.child && state.child.exitCode === null && !state.child.killed)
    return {
      ok: listening,
      name,
      port: spec.port,
      running: listening,
      owned: state.owned && alive,
      pid: alive && state.child?.pid ? state.child.pid : null,
      alreadyRunning: listening && !(state.owned && alive),
      message: listening
        ? `桥接已在 :${spec.port} 监听`
        : state.lastError || `桥接未运行（端口 ${spec.port}）`,
    }
  }

  async function ensure(name: BridgeName): Promise<EnsureResult> {
    const state = managed[name]
    if (state.starting) return state.starting

    const run = (async (): Promise<EnsureResult> => {
      const spec = SPECS[name]
      if (await isPortOpen(spec.port)) {
        return {
          ok: true,
          name,
          port: spec.port,
          running: true,
          owned: Boolean(state.child && state.owned),
          pid: state.child?.pid ?? null,
          alreadyRunning: true,
          message: `已有桥接在 :${spec.port}（跳过启动）`,
        }
      }

      const scriptPath = path.join(projectRoot, spec.script)
      if (!existsSync(scriptPath)) {
        return {
          ok: false,
          name,
          port: spec.port,
          running: false,
          owned: false,
          pid: null,
          alreadyRunning: false,
          message: `找不到脚本 ${spec.script}`,
        }
      }

      // Clear stale child handle
      if (state.child && (state.child.killed || state.child.exitCode !== null)) {
        state.child = null
        state.owned = false
      }

      const py = spec.resolvePython(projectRoot)
      const env = spec.buildEnv(projectRoot)
      state.lastError = ''
      console.log(`\x1b[35m[bridge]\x1b[0m starting ${name}: ${py} ${spec.script}`)

      const child = spawn(py, [scriptPath], {
        cwd: projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      state.child = child
      state.owned = true

      let logBuf = ''
      const onChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        logBuf = (logBuf + text).slice(-4000)
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          console.log(`\x1b[35m[bridge:${name}]\x1b[0m ${line}`)
        }
      }
      child.stdout?.on('data', onChunk)
      child.stderr?.on('data', onChunk)

      child.on('exit', (code, signal) => {
        const msg = `桥接进程退出 code=${code} signal=${signal ?? ''}`
        console.log(`\x1b[35m[bridge]\x1b[0m ${name} ${msg}`)
        if (state.child === child) {
          state.child = null
          state.owned = false
          if (!state.lastError) state.lastError = `${msg}\n${logBuf.trim()}`.trim()
        }
      })

      const deadline = Date.now() + 20000
      let sawReadyLog = false
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          const hint =
            name === 'bcigo'
              ? '请确认已 pip install bcigo-sdk websockets numpy'
              : '请确认 OI_MI_ROOT / oi-mi 与 neuracle 依赖可用'
          return {
            ok: false,
            name,
            port: spec.port,
            running: false,
            owned: false,
            pid: null,
            alreadyRunning: false,
            message: `${state.lastError || '桥接启动失败'}（${hint}）`,
          }
        }
        if (!sawReadyLog && spec.readyPattern.test(logBuf)) {
          sawReadyLog = true
        }
        // Prefer log ready-signal; only probe TCP once to avoid WS handshake noise.
        if (sawReadyLog) {
          await sleep(200)
          if (await isPortOpen(spec.port)) {
            return {
              ok: true,
              name,
              port: spec.port,
              running: true,
              owned: true,
              pid: child.pid ?? null,
              alreadyRunning: false,
              message: `已自动启动 ${name} 桥接 (pid ${child.pid})`,
            }
          }
          // Log said ready but port not open yet — keep waiting briefly
        } else if (await isPortOpen(spec.port)) {
          return {
            ok: true,
            name,
            port: spec.port,
            running: true,
            owned: true,
            pid: child.pid ?? null,
            alreadyRunning: false,
            message: `已自动启动 ${name} 桥接 (pid ${child.pid})`,
          }
        }
        await sleep(150)
      }

      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        name,
        port: spec.port,
        running: false,
        owned: false,
        pid: null,
        alreadyRunning: false,
        message: `等待 :${spec.port} 超时。日志：\n${logBuf.trim() || '(empty)'}`,
      }
    })()

    state.starting = run
    try {
      return await run
    } finally {
      state.starting = null
    }
  }

  function stop(name: BridgeName): EnsureResult {
    const state = managed[name]
    const spec = SPECS[name]
    if (state.child && state.owned) {
      try {
        state.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      state.child = null
      state.owned = false
      return {
        ok: true,
        name,
        port: spec.port,
        running: false,
        owned: false,
        pid: null,
        alreadyRunning: false,
        message: '已停止由本页启动的桥接',
      }
    }
    return {
      ok: true,
      name,
      port: spec.port,
      running: false,
      owned: false,
      pid: null,
      alreadyRunning: false,
      message: '没有由本页托管的桥接进程（外部启动的不会自动杀）',
    }
  }

  function stopAll() {
    for (const name of Object.keys(managed) as BridgeName[]) {
      stop(name)
    }
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    const m = url.match(/^\/api\/bridge\/(bcigo|neuracle)\/(ensure|status|stop)$/)
    if (!m) {
      next()
      return
    }
    const name = m[1] as BridgeName
    const action = m[2]

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.end()
      return
    }

    void (async () => {
      try {
        if (action === 'status' && (req.method === 'GET' || req.method === 'POST')) {
          sendJson(res, 200, await statusOf(name))
          return
        }
        if (action === 'ensure' && req.method === 'POST') {
          const result = await ensure(name)
          sendJson(res, result.ok ? 200 : 500, result)
          return
        }
        if (action === 'stop' && req.method === 'POST') {
          sendJson(res, 200, stop(name))
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
    name: 'bridge-manager',
    configureServer(server) {
      projectRoot = server.config.root
      server.middlewares.use(middleware)
      const exit = () => stopAll()
      server.httpServer?.once('close', exit)
      process.once('exit', exit)
      console.log(
        '\x1b[35m[bridge]\x1b[0m ready — POST /api/bridge/{bcigo|neuracle}/ensure 可一键启动',
      )
    },
  }
}
