import type { Plugin } from 'vite'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { onDevProcessExit, persistentDevStore } from './vite.process-hooks.ts'
import { summarizeSessionDir } from './vite.record-library.ts'
import { listModelHeads, selectModelHead } from './vite.model-heads.ts'
import { findNcc } from './scripts/run-model-service.mjs'
import { operationGate } from './vite.operation-gate.ts'
import { appendRound, createRound, readRound, roundDirectory, loraHistory } from './vite.training-rounds.ts'

type Job = {
  id: string; kind: 'export' | 'fit' | 'lora'; status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted'
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
            const roundRoute = url.match(/^\/api\/training\/rounds(?:\/([a-f0-9-]{36}))?$/)
            if (roundRoute) {
              const roundId = roundRoute[1]
              if (req.method === 'GET' && roundId) { send(200, { ok: true, round: readRound(root, roundId) }); return }
              if (req.method !== 'POST') { send(405, { ok: false }); return }
              let raw = ''
              for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 65536) throw new Error('请求过大') }
              const body = JSON.parse(raw)
              if (!roundId) {
                send(201, { ok: true, round: createRound(root, randomUUID(), body.subjectId, body.seed) }); return
              }
              if (!['group_saved', 'model_decision', 'interrupted', 'complete', 'error'].includes(body.type)) throw new Error('无效轮次事件')
              if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new Error('无效轮次数据')
              appendRound(root, roundId, body.type, body.data)
              send(200, { ok: true }); return
            }
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
            const detail = url.match(/^\/api\/training\/jobs\/([a-f0-9-]+)(?:\/(dataset.h5|head.pt|adapter.pt|report.json|log.txt|cancel))?$/)
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
                if (action === 'adapter.pt' && (job.kind !== 'lora' || job.status !== 'complete')) throw new Error('LoRA 产物尚未完成')
                const file = action === 'adapter.pt' ? String(job.config.adapterOutput) : path.join(dir, action)
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
                send(200, { ok: true, job, active: state.active?.job.id === id, log,
                  report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null }); return
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
              const roundId = typeof body.roundId === 'string' ? body.roundId : null
              const round = roundId ? readRound(root, roundId) : null
              let config: Record<string, unknown>
              if (body.kind === 'export') {
                if (body.scope !== undefined && body.scope !== 'history') throw new Error('无效数据范围')
                if (body.scope === 'history' && !round) throw new Error('历史导出需要采集轮次')
                const history = body.scope === 'history' && round ? loraHistory(root, round) : null
                if (history) body.sessions = history.rounds.flatMap(r => r.sessions.map(s => path.basename(s)))
                if (!Array.isArray(body.sessions) || !body.sessions.length || body.sessions.length > 100) throw new Error('请选择 1–100 个录制会话')
                const sessions = body.sessions.map(stem => {
                  if (typeof stem !== 'string') throw new Error('无效会话')
                  const info = summarizeSessionDir(path.join(root, 'recordings'), stem)
                  if (!info || info.status !== 'complete' || info.eegBytes <= 0 || !info.events) throw new Error('需要已完成且包含 EEG 和标签事件的会话')
                  if (round) {
                    const events = readFileSync(path.join(root, 'recordings', stem, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
                    const ownerId = history?.rounds.find(r => r.sessions.includes(path.join(root, 'recordings', stem)))?.id ?? roundId
                    if (!events.some(e => e.type === 'group_end' && e.data?.complete === true && e.data?.roundId === ownerId)
                      || events.some(e => e.type === 'group_interrupted' || e.type === 'trial_invalid' || e.data?.valid === false)
                      || events.some(e => e.subjectId !== round.subjectId)) throw new Error('组未完整结束或被试／轮次不匹配')
                  }
                  return path.join(root, 'recordings', stem)
                })
                if (body.labelSource !== 'auto' && body.labelSource !== 'trial') throw new Error('无效标签来源')
                config = { sessions: [...new Set(sessions)], subjectId: round ? 1 : trainingNumber(body.subjectId, 1, 999999, true),
                  labelSource: round ? 'trial' : body.labelSource, ...(round ? { roundId, subjectLabel: round.subjectId,
                    recordingManifest: path.join(roundDirectory(root, round.id), 'recordings.json') } : {}),
                  ...(history ? { scope: 'history', history } : {}) }
              } else if (body.kind === 'fit' || body.kind === 'lora') {
                if (body.kind === 'lora' && !round) throw new Error('LoRA 需要采集轮次')
                const source = readJob(String(body.datasetId))
                if (source.kind !== 'export' || source.status !== 'complete') throw new Error('请选择已完成导出的 H5')
                if (!['session', 'trial'].includes(String(body.splitBy))) throw new Error('无效分组方式')
                if (!['cpu', 'auto', 'cuda'].includes(String(body.device))) throw new Error('无效计算设备')
                const head = body.headId ? selectModelHead(await listModelHeads(root), String(body.headId), 'smr_control') : null
                config = { dataset: path.join(jobsRoot(), source.id, 'dataset.h5'), sourceJobId: source.id,
                  headOutput: path.join(root, 'recordings', '.reve-heads', `smr_control_${body.kind === 'lora' ? 'lora' : 'lp'}_${id}.pt`),
                  loraCheckpoint: head?.loraCheckpoint ?? null, size: head?.size ?? 'base',
                  epochs: trainingNumber(body.epochs, 1, body.kind === 'lora' ? 100 : 5000, true), lr: trainingNumber(body.lr, .000001, body.kind === 'lora' ? .01 : 1),
                  seed: trainingNumber(body.seed, 0, 0xffffffff, true), splitBy: body.splitBy, device: body.device }
                if (round) {
                  if (source.config.roundId !== roundId || body.splitBy !== 'trial') throw new Error('训练数据不属于当前轮次')
                  if ((body.kind === 'lora') !== (source.config.scope === 'history')) throw new Error('LoRA 必须使用历史快照，probing 必须使用本轮数据')
                  if (typeof body.baselineRevision !== 'string' || !/^[\w.-]+$/.test(body.baselineRevision)) throw new Error('需要采集模型的实际版本')
                  let lora = head?.loraCheckpoint ?? null
                  const size = head?.size ?? (body.modelName === 'reve-large' ? 'large' : 'base')
                  if (!head && body.baselineRevision !== `reve-${size}`) {
                    const ncc = findNcc()
                    if (!ncc) throw new Error('找不到 NCC-OI-BCI')
                    lora = process.env.MODEL_REVE_LORA || path.join(ncc, 'checkpoints', 'adapters', body.baselineRevision, 'best.pt')
                    if (!existsSync(lora) || path.basename(path.dirname(lora)) !== body.baselineRevision) throw new Error('无法定位当前模型的 LoRA，请选择明确的分类头')
                  }
                  config = { ...config, roundId, seed: round.seed, splitBy: 'trial', size, loraCheckpoint: lora,
                    baselineRevision: body.baselineRevision, baselineStateFile: head?.stateFile ?? null,
                    baselineOutput: path.join(root, 'recordings', '.reve-heads', `smr_control_baseline_${id}.pt`),
                    splitLedger: path.join(roundDirectory(root, round.id), 'split.json'),
                    minimumGain: trainingNumber(body.minimumGain, 0, 1), maximumRecallDrop: trainingNumber(body.maximumRecallDrop, 0, 1) }
                  if (body.kind === 'lora') config = { ...config, history: source.config.history,
                    adapterOutput: path.join(root, 'recordings', '.reve-adapters', `smr_lora_${id}`, 'best.pt'),
                    rank: trainingNumber(body.rank ?? 4, 1, 64, true), alpha: trainingNumber(body.alpha ?? 8, 1, 128),
                    batchSize: trainingNumber(body.batchSize ?? 1, 1, 8, true),
                    accumulationSteps: trainingNumber(body.accumulationSteps ?? 8, 1, 64, true) }
                }
              } else throw new Error('无效任务类型')
              mkdirSync(dir, { recursive: true })
              const job: Job = { id, kind: body.kind, config, status: 'running', startedAt: new Date().toISOString() }
              const save = () => writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
              save()
              const release = round ? operationGate.beginModelChange() : () => {}
              let child: ChildProcess
              try {
                if (round) appendRound(root, round.id, 'job_started', { jobId: id, kind: job.kind, config })
                child = spawn(process.execPath, [path.join(root, 'scripts/run-training.mjs'), path.join(dir, 'job.json')], {
                cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
                })
              } catch (error) { release(); throw error }
              state.active = { child, job, dir }
              const log = (chunk: Buffer) => appendFileSync(path.join(dir, 'log.txt'), chunk)
              child.stdout?.on('data', log); child.stderr?.on('data', log)
              child.on('error', error => { job.error = error.message })
              child.on('close', code => {
                release()
                if (job.status !== 'cancelled') {
                  job.status = code === 0 && existsSync(path.join(dir, 'report.json')) ? 'complete' : 'failed'
                  if (job.status === 'failed') job.error ||= `任务退出（${code}），请查看日志`
                }
                job.endedAt = new Date().toISOString(); save()
                if (round) appendRound(root, round.id, 'job_finished', { jobId: id, status: job.status, error: job.error ?? null })
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
