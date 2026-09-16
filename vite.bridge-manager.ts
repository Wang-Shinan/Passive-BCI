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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { onDevProcessExit, persistentDevStore } from './vite.process-hooks.ts'

type BridgeName = 'bcigo' | 'neuracle' | 'omni'

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
  omni: {
    name: 'omni',
    port: 8771,
    script: 'bridges/omni/lsl_ws_bridge.py',
    readyPattern: /\[omni-lsl-bridge\].*ready/i,
    buildEnv: () => ({ ...process.env, PYTHONUNBUFFERED: '1' }),
    resolvePython: () => process.env.OMNI_LSL_PYTHON || findPython(),
  },
  bcigo: {
    name: 'bcigo',
    port: 8767,
    script: 'bridges/bcigo/ws_bridge.py',
    readyPattern: /\[bcigo-bridge\].*waiting/i,
    buildEnv: (_root) => ({ ...process.env, PYTHONUNBUFFERED: '1' }),
    resolvePython: () => process.env.BCIGO_PYTHON || findPython(),
  },
  neuracle: {
    name: 'neuracle',
    port: 8766,
    script: 'bridges/neuracle/ws_bridge.py',
    readyPattern: /\[neuracle-bridge\].*waiting/i,
    buildEnv: (root) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' }
      const oi = resolveOiMiRoot()
      if (oi) env.OI_MI_ROOT = oi
      else delete env.OI_MI_ROOT
      const ncc = resolveNccSrc(root)
      if (ncc) env.NCC_OI_BCI_SRC = ncc
      return env
    },
    resolvePython: (root) => {
      const oi = resolveOiMiRoot()
      const ncc = resolveNccSrc(root)
      const venvCandidates = [
        oi && path.join(oi, '.venv', 'Scripts', 'python.exe'),
        oi && path.join(oi, '.venv', 'bin', 'python'),
        ncc && path.join(ncc, '..', '.venv', 'Scripts', 'python.exe'),
        ncc && path.join(ncc, '..', '.venv', 'bin', 'python'),
      ]
      for (const venvPy of venvCandidates) {
        if (venvPy && existsSync(venvPy)) return venvPy
      }
      return process.env.NEURACLE_PYTHON || findPython()
    },
  },
}

function resolveOiMiRoot(): string | undefined {
  const raw = [
    process.env.OI_MI_ROOT,
    path.join(os.homedir(), 'Documents', 'oi-mi'),
  ]
  for (const item of raw) {
    if (!item) continue
    if (existsSync(path.join(item, 'collect', 'neuracle_api.py'))) return item
  }
  return undefined
}

function resolveNccSrc(projectRoot: string): string | undefined {
  const raw = [
    process.env.NCC_OI_BCI_SRC,
    path.resolve(projectRoot, '..', 'NCC-OI-BCI', 'src'),
    path.join(os.homedir(), 'Desktop', 'NCC-OI-BCI', 'src'),
  ]
  for (const item of raw) {
    if (!item) continue
    if (existsSync(path.join(item, 'bci_dayloop', 'vendor', 'neuracle', 'neuracle_api.py'))) {
      return item
    }
  }
  return undefined
}

/** Windows `python3` is often the Microsoft Store stub (exit 9009). Probe real interpreters. */
function findPython(): string {
  const win = process.platform === 'win32'
  const names = win
    ? [process.env.PYTHON, 'python', 'py', 'python3']
    : [process.env.PYTHON, 'python3', 'python']
  for (const name of names.filter((n): n is string => Boolean(n))) {
    try {
      const args =
        name === 'py'
          ? ['-3', '-c', 'import sys; print(sys.executable)']
          : ['-c', 'import sys; print(sys.executable)']
      const out = execFileSync(name, args, {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      })
      const exe = out.trim().split(/\r?\n/).find((line) => line.length > 0)
      if (exe && existsSync(exe)) return exe
      if (exe) return exe
    } catch {
      /* try next */
    }
  }
  return win ? 'python' : 'python3'
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
  const managed = persistentDevStore('bridge-manager', (): Record<BridgeName, ManagedBridge> => ({
    omni: { child: null, owned: false, lastError: '', starting: null },
    bcigo: { child: null, owned: false, lastError: '', starting: null },
    neuracle: { child: null, owned: false, lastError: '', starting: null },
  }))
  // Vite reloads config inside the same process; migrate stores created by an older config.
  managed.omni ??= { child: null, owned: false, lastError: '', starting: null }
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
              ? child.exitCode === 9009
                ? 'Windows 找不到 python3（退出码 9009）。请用 Anaconda 的 python，或设置 BCIGO_PYTHON'
                : '请确认已 pip install bcigo-sdk websockets numpy'
              : name === 'omni'
                ? '请执行 pip install -r bridges/omni/requirements.txt'
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

  function collectPids(): number[] {
    if (process.platform !== 'win32') return []
    try {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Neuracle.JellyFish.View.Main.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true },
      )
      return out
        .split(/\r?\n/)
        .map((line) => line.split(',').map((part) => part.trim().replace(/^"|"$/g, '')))
        .filter((parts) => parts[0]?.includes('JellyFish'))
        .map((parts) => Number(parts[1]))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    } catch {
      return []
    }
  }

  function jellyfishListenPorts(): number[] {
    const pids = new Set(collectPids())
    if (!pids.size) return []
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
      })
      const ports: number[] = []
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue
        const port = Number(parts[1].split(':').pop())
        const pid = Number(parts[4])
        if (pids.has(pid) && Number.isFinite(port) && !ports.includes(port)) ports.push(port)
      }
      return ports
    } catch {
      return []
    }
  }

  function tcpConnects(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port }, () => {
        sock.destroy()
        resolve(true)
      })
      sock.setTimeout(200)
      sock.on('error', () => resolve(false))
      sock.on('timeout', () => {
        sock.destroy()
        resolve(false)
      })
    })
  }

  function collectConfigPorts(): number[] {
    const ports: number[] = []
    for (const conf of [
      'D:\\Programs\\Collect\\Conf\\SystemSetting.json',
      'C:\\Programs\\Collect\\Conf\\SystemSetting.json',
    ]) {
      if (!existsSync(conf)) continue
      try {
        const raw = JSON.parse(readFileSync(conf, 'utf8')) as {
          DataTransferPort?: number
          DataServicePort?: number
        }
        for (const key of ['DataTransferPort', 'DataServicePort'] as const) {
          const port = Number(raw[key])
          if (Number.isFinite(port) && port > 0 && !ports.includes(port)) ports.push(port)
        }
      } catch {
        /* ignore */
      }
    }
    return ports
  }

  async function probeNeuracle() {
    const collect = collectPids().length > 0
    const owned = jellyfishListenPorts()
    if (owned.length) {
      return {
        ok: true,
        listening: true,
        collect,
        port: owned[0]!,
        message: `已自动探测到 Collect 转发口 ${owned.join('/')}，可以连接。`,
      }
    }
    const scan = [
      ...collectConfigPorts(),
      ...Array.from({ length: 31 }, (_, i) => 8700 + i),
      4097,
    ].filter((port, i, all) => all.indexOf(port) === i)
    const hits = (
      await Promise.all(scan.map(async (port) => ((await tcpConnects(port)) ? port : 0)))
    ).filter((port) => port > 0)
    if (hits.length) {
      return {
        ok: true,
        listening: true,
        collect,
        port: hits[0]!,
        message: `已自动探测到转发口 ${hits.join('/')}，可以连接。`,
      }
    }
    return {
      ok: false,
      listening: false,
      collect,
      port: 0,
      message: collect
        ? 'Collect 已打开，但还没有 TCP 转发口。请在采集界面点「数据转发」（不是 LSL）→ 选探头 →「开始」。端口会自动识别。'
        : '未发现 Collect，也扫不到转发口。请先打开 Collect 并开始实验。',
    }
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (url === '/api/bridge/omni/probe' && (req.method === 'GET' || req.method === 'POST')) {
      void isPortOpen(8771)
        .then((listening) =>
          sendJson(res, 200, {
            ok: listening,
            listening,
            port: 8771,
            message: listening
              ? 'OmniBCI LSL 桥接已在 :8771 监听，可以连接。'
              : 'OmniBCI LSL 桥接尚未启动。',
          }),
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          sendJson(res, 500, { ok: false, listening: false, port: 8771, message })
        })
      return
    }
    if (url === '/api/bridge/neuracle/probe' && (req.method === 'GET' || req.method === 'POST')) {
      void probeNeuracle()
        .then((body) => sendJson(res, 200, body))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          sendJson(res, 500, { ok: false, message })
        })
      return
    }
    const m = url.match(/^\/api\/bridge\/(bcigo|neuracle|omni)\/(ensure|status|stop)$/)
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
      // Vite config reloads close httpServer but keep this Node process.
      // Do not SIGTERM owned bridges here — only on real process exit.
      onDevProcessExit('bridge-manager', stopAll)
      console.log(
        '\x1b[35m[bridge]\x1b[0m ready — POST /api/bridge/{omni|bcigo|neuracle}/ensure 可一键启动',
      )
    },
  }
}
