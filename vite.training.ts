import type { Plugin } from 'vite'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { onDevProcessExit, persistentDevStore } from './vite.process-hooks.ts'
import { summarizeSessionDir } from './vite.record-library.ts'
import { listModelHeads, selectModelHead } from './vite.model-heads.ts'

type Job = {
  id: string; kind: 'export' | 'fit'; status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string; endedAt?: string; config: Record<string, unknown>; error?: string
}
const ID = /^[a-f0-9-]{36}$/
export function trainingNumber(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error('训练参数超出允许范围')
  return value
}
export function trainingPlugin(): Plugin {
  let root = process.cwd()
  const state = persistentDevStore('training-jobs', () => ({ active: null as { job: Job; child: ChildProcess; dir: string } | null, starting: false }))
  const jobsRoot = () => path.join(root, 'recordings', '.training')
  const readJob = (id: string): Job => {
    if (!ID.test(id)) throw new Error('无效任务编号')
    return JSON.parse(readFileSync(path.join(jobsRoot(), id, 'job.json'), 'utf8')) as Job
  }
  const cancel = () => {
    const active = state.active
    if (!active) return
    active.job.status = 'cancelled'
    active.job.endedAt = new Date().toISOString()
    writeFileSync(path.join(active.dir, 'job.json'), JSON.stringify(active.job, null, 2))
    if (active.child.pid) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 }) } catch { /* Process already stopped. */ }
      } else active.child.kill('SIGTERM')
    }
  }
  return {
    name: 'training-jobs',
    configureServer(server) {
      root = server.config.root
      onDevProcessExit('training-jobs', cancel)
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (!url.startsWith('/api/training/')) { next(); return }
        const send = (code: number, value: unknown) => {
          res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value))
        }
        void (async () => {
          try {
            if (url === '/api/training/jobs' && req.method === 'GET') {
              const jobs = existsSync(jobsRoot()) ? readdirSync(jobsRoot()).filter(id => ID.test(id)).flatMap(id => {
                try {
                  const job = readJob(id)
                  if (job.status === 'running' && state.active?.job.id !== id) job.status = 'interrupted'
                  return [job]
                } catch { return [] }
              }) : []
              send(200, { ok: true, jobs: jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)), busy: Boolean(state.active || state.starting) }); return
            }
            const detail = url.match(/^\/api\/training\/jobs\/([a-f0-9-]+)(?:\/(dataset.h5|head.pt|report.json|log.txt|cancel))?$/)
            if (detail) {
              const id = detail[1]!
              const job = readJob(id)
              const action = detail[2]
              if (action === 'cancel' && req.method === 'POST') {
                if (state.active?.job.id !== id) throw new Error('该任务未运行')
                cancel(); send(200, { ok: true }); return
              }
              const dir = path.join(jobsRoot(), id)
              if (req.method === 'GET' && action) {
                const file = path.join(dir, action)
                if (!existsSync(file)) { send(404, { ok: false, message: '文件尚未生成' }); return }
                res.setHeader('Content-Type', 'application/octet-stream')
                res.setHeader('Content-Disposition', `attachment; filename="${id}_${action}"`)
                const stream = createReadStream(file)
                stream.on('error', () => res.destroy())
                stream.pipe(res); return
              }
              if (req.method === 'GET') {
                const reportPath = path.join(dir, 'report.json')
                const logPath = path.join(dir, 'log.txt')
                const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-20000) : ''
                if (job.status === 'running' && state.active?.job.id !== id) job.status = 'interrupted'
                send(200, { ok: true, job, log, report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null }); return
              }
            }
            if (url !== '/api/training/jobs' || req.method !== 'POST') { send(405, { ok: false }); return }
            if (state.active || state.starting) { send(409, { ok: false, message: '已有任务运行，请等待或取消' }); return }
            state.starting = true
            try {
              let raw = ''
              for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 65536) throw new Error('请求过大') }
              const body = JSON.parse(raw) as Record<string, unknown>
              const id = randomUUID()
              const dir = path.join(jobsRoot(), id)
              let config: Record<string, unknown>
              if (body.kind === 'export') {
                if (!Array.isArray(body.sessions) || !body.sessions.length || body.sessions.length > 100) throw new Error('请选择 1–100 个录制会话')
                const sessions = body.sessions.map(stem => {
                  if (typeof stem !== 'string') throw new Error('无效会话')
                  const info = summarizeSessionDir(path.join(root, 'recordings'), stem)
                  if (!info || info.status !== 'complete' || info.eegBytes <= 0 || !info.events) throw new Error('需要已完成且包含 EEG 和标签事件的会话')
                  return path.join(root, 'recordings', stem)
                })
                if (body.labelSource !== 'auto' && body.labelSource !== 'trial') throw new Error('无效标签来源')
                config = { sessions: [...new Set(sessions)], subjectId: trainingNumber(body.subjectId, 1, 999999, true), labelSource: body.labelSource }
              } else if (body.kind === 'fit') {
                const source = readJob(String(body.datasetId))
                if (source.kind !== 'export' || source.status !== 'complete') throw new Error('请选择已完成导出的 H5')
                if (!['session', 'trial'].includes(String(body.splitBy))) throw new Error('无效分组方式')
                if (!['cpu', 'auto', 'cuda'].includes(String(body.device))) throw new Error('无效计算设备')
                const head = body.headId ? selectModelHead(await listModelHeads(root), String(body.headId), 'smr_control') : null
                config = { dataset: path.join(jobsRoot(), source.id, 'dataset.h5'), sourceJobId: source.id,
                  headOutput: path.join(root, 'recordings', '.reve-heads', `smr_control_lp_${id}.pt`),
                  loraCheckpoint: head?.loraCheckpoint ?? null, size: head?.size ?? 'base',
                  epochs: trainingNumber(body.epochs, 1, 5000, true), lr: trainingNumber(body.lr, .000001, 1),
                  seed: trainingNumber(body.seed, 0, 2147483647, true), splitBy: body.splitBy, device: body.device }
              } else throw new Error('无效任务类型')
              mkdirSync(dir, { recursive: true })
              const job: Job = { id, kind: body.kind, config, status: 'running', startedAt: new Date().toISOString() }
              const save = () => writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
              save()
              const child = spawn(process.execPath, [path.join(root, 'scripts/run-training.mjs'), path.join(dir, 'job.json')], {
                cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
              })
              state.active = { child, job, dir }
              const log = (chunk: Buffer) => appendFileSync(path.join(dir, 'log.txt'), chunk)
              child.stdout?.on('data', log); child.stderr?.on('data', log)
              child.on('error', error => { job.error = error.message })
              child.on('close', code => {
                if (job.status !== 'cancelled') {
                  job.status = code === 0 && existsSync(path.join(dir, 'report.json')) ? 'complete' : 'failed'
                  if (job.status === 'failed') job.error ||= `任务退出（${code}），请查看日志`
                }
                job.endedAt = new Date().toISOString(); save()
                if (state.active?.job.id === id) state.active = null
              })
              send(202, { ok: true, job })
            } finally { state.starting = false }
          } catch (error) { send(400, { ok: false, message: error instanceof Error ? error.message : String(error) }) }
        })()
      })
    },
  }
}
