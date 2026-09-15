/**
 * Vite plugin: one-click start/stop for the local NCC model WebSocket
 * (REVE / mock) so the online-learn UI need not ask users for npm scripts.
 *
 *   POST /api/model-service/ensure   { backend?: 'reve'|'mock', force?: boolean }
 *   GET  /api/model-service/status
 *   POST /api/model-service/stop
 */

import type { Plugin } from 'vite'
import type { Connect } from 'vite'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { onDevProcessExit, persistentDevStore } from './vite.process-hooks.ts'

export type ModelServiceBackend = 'reve' | 'mock'

interface ManagedService {
  child: ChildProcess | null
  owned: boolean
  backend: ModelServiceBackend | null
  task: string | null
  stepSec: number | null
  lastError: string
  logBuf: string
  starting: Promise<EnsureResult> | null
}

export interface EnsureResult {
  ok: boolean
  backend: ModelServiceBackend | null
  port: number
  running: boolean
  owned: boolean
  pid: number | null
  alreadyRunning: boolean
  starting: boolean
  task?: string | null
  stepSec?: number | null
  message?: string
  logTail?: string
}

const PORT = 8768
const READY_PATTERN = /\[model-service\].*waiting for Passive BCI windows/i
const TIMEOUT_MS: Record<ModelServiceBackend, number> = {
  reve: 180_000,
  mock: 25_000,
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function rewriteModelWsPath(url: string): string {
  const path = url.replace(/^\/ws\/model/, '')
  return path.length > 0 ? path : '/'
}

/** Proxy /ws/model without Vite's ECONNREFUSED stack dump when REVE is down. */
function proxyModelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const target = net.connect(PORT, '127.0.0.1')
  const fail = () => {
    target.destroy()
    if (!socket.destroyed) socket.destroy()
  }
  target.once('error', fail)
  socket.once('error', fail)
  target.once('connect', () => {
    const dest = rewriteModelWsPath(req.url ?? '/')
    let msg = `GET ${dest} HTTP/1.1\r\n`
    const headers = { ...req.headers, host: `127.0.0.1:${PORT}` }
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue
      msg += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
    }
    msg += '\r\n'
    target.write(msg)
    if (head.length) target.write(head)
    target.pipe(socket)
    socket.pipe(target)
  })
}

function attachModelWsProxy(httpServer: {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown
}): void {
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws/model')) return
    proxyModelUpgrade(req, socket, head)
  })
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
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

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function pidsOnPort(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      })
      const pids = new Set<number>()
      for (const line of out.split(/\r?\n/)) {
        if (!/\bLISTENING\b/i.test(line)) continue
        const parts = line.trim().split(/\s+/)
        const local = parts[1] ?? ''
        const pid = Number(parts[4])
        if (!Number.isInteger(pid) || pid <= 0) continue
        if (local.endsWith(`:${port}`) || local.includes(`]:${port}`)) pids.add(pid)
      }
      return [...pids]
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      timeout: 8000,
    })
    return [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0),
      ),
    ]
  } catch {
    return []
  }
}

function killPidTree(pid: number) {
  if (!pid || pid === process.pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        timeout: 8000,
        windowsHide: true,
        stdio: 'ignore',
      })
      return
    }
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

async function freePort(port: number) {
  for (const pid of pidsOnPort(port)) killPidTree(pid)
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return
    await sleep(150)
  }
}

function parseBackend(value: unknown): ModelServiceBackend {
  return value === 'mock' ? 'mock' : 'reve'
}

function parseReveTask(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, '_') : ''
  if (raw === 'gaze_smr') return 'gaze_smr'
  if (raw === 'tetris' || raw === 'tetris_action' || raw === 'action') return 'tetris_action'
  if (raw === 'smr' || raw === 'smr_control' || raw === 'smr_cursor' || raw === 'cursor') return 'smr_control'
  return 'passive_rating'
}

function defaultLiveStepSec(task: string): number {
  return task === 'tetris_action' ? 0.1 : 0.5
}

function parseStepSec(value: unknown, task: string): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (Number.isFinite(raw) && raw > 0) return raw
  return defaultLiveStepSec(task)
}

function hopMatches(actual: number | null | undefined, wanted: number): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - wanted) < 1e-6
}

export function modelServiceManagerPlugin(): Plugin {
  const state = persistentDevStore(
    'model-service-manager',
    (): ManagedService => ({
      child: null,
      owned: false,
      backend: null,
      task: null,
      stepSec: null,
      lastError: '',
      logBuf: '',
      starting: null,
    }),
  )
  let projectRoot = process.cwd()

  function snapshot(extra: Partial<EnsureResult> = {}): EnsureResult {
    const alive = Boolean(state.child && state.child.exitCode === null && !state.child.killed)
    return {
      ok: extra.ok ?? true,
      backend: extra.backend ?? state.backend,
      task: extra.task ?? state.task,
      stepSec: extra.stepSec ?? state.stepSec,
      port: PORT,
      running: extra.running ?? false,
      owned: extra.owned ?? (state.owned && alive),
      pid: extra.pid ?? (alive && state.child?.pid ? state.child.pid : null),
      alreadyRunning: extra.alreadyRunning ?? false,
      starting: extra.starting ?? Boolean(state.starting),
      message: extra.message,
      logTail: extra.logTail ?? state.logBuf.slice(-2500),
    }
  }

  async function statusOf(): Promise<EnsureResult> {
    const listening = await isPortOpen(PORT)
    const alive = Boolean(state.child && state.child.exitCode === null && !state.child.killed)
    return snapshot({
      ok: listening || Boolean(state.starting),
      running: listening,
      owned: state.owned && alive,
      alreadyRunning: listening && !(state.owned && alive),
      message: state.starting
        ? `正在启动 ${state.backend ?? '模型服务'}…`
        : listening
          ? state.owned && alive
            ? `本页托管的 ${state.backend ?? '模型服务'}${state.task ? `/${state.task}` : ''} 已在 :${PORT} 监听`
            : `已有进程在 :${PORT} 监听（不是本页启动的）`
          : state.lastError || `模型服务未运行（端口 ${PORT}）`,
    })
  }

  function stopOwned(): void {
    const child = state.child
    if (child && state.owned && child.pid) {
      killPidTree(child.pid)
    }
    state.child = null
    state.owned = false
    state.backend = null
    state.task = null
    state.stepSec = null
  }

  async function ensure(
    backend: ModelServiceBackend,
    force: boolean,
    task: string,
    stepSec: number,
  ): Promise<EnsureResult> {
    if (state.starting) return state.starting

    const run = (async (): Promise<EnsureResult> => {
      const listening = await isPortOpen(PORT)
      const alive = Boolean(state.child && state.child.exitCode === null && !state.child.killed)

      const wantedTask = backend === 'reve' ? task : null
      const hopOk = backend !== 'reve' || hopMatches(state.stepSec, stepSec)
      if (
        listening &&
        alive &&
        state.owned &&
        state.backend === backend &&
        state.task === wantedTask &&
        hopOk &&
        !force
      ) {
        return snapshot({
          ok: true,
          running: true,
          alreadyRunning: true,
          message: `${backend}${wantedTask ? `/${wantedTask}` : ''} 已在 :${PORT} 运行`,
        })
      }

      if (listening && !(state.owned && alive) && !force) {
        return snapshot({
          ok: false,
          running: true,
          alreadyRunning: true,
          owned: false,
          message:
            `端口 ${PORT} 已被其他进程占用。若那是 mock / 旧服务，请点「启动 REVE」强制替换，或先关掉对应终端。`,
        })
      }

      if (listening || (state.owned && alive) || force) {
        stopOwned()
        if (force || listening) await freePort(PORT)
      }

      const scriptPath = path.join(projectRoot, 'scripts', 'run-model-service.mjs')
      if (!existsSync(scriptPath)) {
        return snapshot({
          ok: false,
          running: false,
          message: '找不到 scripts/run-model-service.mjs',
        })
      }

      state.lastError = ''
      state.logBuf = ''
      state.backend = backend
      state.task = wantedTask
      state.stepSec = backend === 'reve' ? stepSec : null
      console.log(
        `\x1b[36m[model-service]\x1b[0m starting ${backend}${wantedTask ? `/${wantedTask}` : ''}${
          backend === 'reve' ? ` hop=${stepSec}s` : ''
        }: node scripts/run-model-service.mjs`,
      )

      const spawnArgs = [scriptPath, '--backend', backend]
      if (backend === 'reve') {
        spawnArgs.push('--task', task)
        spawnArgs.push('--step-sec', String(stepSec))
        if (task === 'smr_control' || task === 'gaze_smr') spawnArgs.push('--strategy', 'none')
      }
      const child = spawn(process.execPath, spawnArgs, {
        cwd: projectRoot,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      state.child = child
      state.owned = true

      const onChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        state.logBuf = (state.logBuf + text).slice(-8000)
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          console.log(`\x1b[36m[model-service]\x1b[0m ${line}`)
        }
      }
      child.stdout?.on('data', onChunk)
      child.stderr?.on('data', onChunk)

      child.on('exit', (code, signal) => {
        const msg = `模型服务退出 code=${code} signal=${signal ?? ''}`
        console.log(`\x1b[36m[model-service]\x1b[0m ${msg}`)
        if (state.child === child) {
          state.child = null
          state.owned = false
          if (!state.lastError) state.lastError = `${msg}\n${state.logBuf.trim()}`.trim()
        }
      })

      const deadline = Date.now() + TIMEOUT_MS[backend]
      let sawReadyLog = false
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          return snapshot({
            ok: false,
            running: false,
            owned: false,
            pid: null,
            backend,
            message: `${state.lastError || '模型服务启动失败'}。请确认 NCC-OI-BCI 与 bci-dayloop 环境可用。`,
          })
        }
        if (!sawReadyLog && READY_PATTERN.test(state.logBuf)) sawReadyLog = true
        if (sawReadyLog && (await isPortOpen(PORT))) {
          return snapshot({
            ok: true,
            running: true,
            owned: true,
            alreadyRunning: false,
            backend,
            message:
              backend === 'reve'
                ? `已启动本地 REVE（${task}，pid ${child.pid}，2s 窗 / ${stepSec}s 步）`
                : `已启动 dev mock（pid ${child.pid}）`,
          })
        }
        await sleep(250)
      }

      try {
        if (child.pid) killPidTree(child.pid)
      } catch {
        /* ignore */
      }
      return snapshot({
        ok: false,
        running: false,
        owned: false,
        pid: null,
        backend,
        message: `等待 :${PORT} 超时。日志：\n${state.logBuf.trim() || '(empty)'}`,
      })
    })()

    state.starting = run
    try {
      return await run
    } finally {
      state.starting = null
    }
  }

  function stop(): EnsureResult {
    if (state.child && state.owned) {
      stopOwned()
      return snapshot({
        ok: true,
        running: false,
        owned: false,
        pid: null,
        backend: null,
        message: '已停止由本页启动的模型服务',
      })
    }
    return snapshot({
      ok: true,
      running: false,
      owned: false,
      pid: null,
      alreadyRunning: false,
      message: '没有由本页托管的模型服务（外部启动的不会自动杀，请勾选强制启动或关掉对应终端）',
    })
  }

  let gazeFitting = false
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split('?')[0] ?? ''
    if (!url.startsWith('/api/model-service/')) {
      next()
      return
    }
    const action = url.slice('/api/model-service/'.length)

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
        if (action === 'gaze-smr-model' && req.method === 'GET') {
          const report = path.join(projectRoot, 'recordings', '.reve-heads', 'gaze_smr_active.json')
          sendJson(res, 200, { ok: true, model: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null })
          return
        }
        if (action === 'fit-gaze-smr' && req.method === 'POST') {
          if (gazeFitting) { sendJson(res, 409, { ok: false, message: 'REVE LP 正在训练' }); return }
          const body = await readJson(req)
          if (typeof body.session !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.session)
            || typeof body.subject !== 'string' || !body.subject.trim()) throw new Error('Invalid session or subject')
          gazeFitting = true
          try {
            const ncc = process.env.NCC_OI_BCI_ROOT || path.resolve(projectRoot, '..', 'NCC-OI-BCI')
            const python = process.env.NCC_PYTHON || path.join(ncc, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
            const output = await new Promise<string>((resolve, reject) => execFile(python,
              [path.join(ncc, 'scripts', 'fit_gaze_smr_head.py'), '--recordings', path.join(projectRoot, 'recordings'), '--session', body.session as string, '--subject', body.subject as string],
              { cwd: ncc, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } },
              (err, stdout, stderr) => err ? reject(new Error(stderr.slice(-3000) || err.message)) : resolve(stdout)))
            const result = output.split(/\r?\n/).find(line => line.startsWith('RESULT '))
            if (!result) throw new Error('REVE fitting returned no model report')
            sendJson(res, 200, { ok: true, model: JSON.parse(result.slice(7)) })
          } finally { gazeFitting = false }
          return
        }
        if (action === 'status' && (req.method === 'GET' || req.method === 'POST')) {
          sendJson(res, 200, await statusOf())
          return
        }
        if (action === 'ensure' && req.method === 'POST') {
          const body = await readJson(req)
          const result = await ensure(
            parseBackend(body.backend),
            body.force === true,
            parseReveTask(body.task),
            parseStepSec(body.stepSec ?? body.step_sec, parseReveTask(body.task)),
          )
          sendJson(res, result.ok ? 200 : 409, result)
          return
        }
        if (action === 'stop' && req.method === 'POST') {
          sendJson(res, 200, stop())
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
    name: 'model-service-manager',
    configureServer(server) {
      projectRoot = server.config.root
      server.middlewares.use(middleware)
      if (server.httpServer) attachModelWsProxy(server.httpServer)
      // Keep REVE/mock alive across Vite config reloads; kill only on process exit.
      onDevProcessExit('model-service-manager', stopOwned)
      console.log(
        '\x1b[36m[model-service]\x1b[0m ready — POST /api/model-service/ensure 可一键启动 REVE',
      )
    },
  }
}
