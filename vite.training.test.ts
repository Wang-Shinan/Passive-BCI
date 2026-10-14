import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import type { EventEmitter } from 'node:events'

const processes = vi.hoisted(() => new Map<string, EventEmitter>())
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { ...actual, spawn: vi.fn((_exe: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    processes.set(args[1]!, child)
    return child
  }) }
})
import { trainingPlugin } from './vite.training'
import { recordWriterPlugin } from './vite.record-writer'
import { operationGate } from './vite.operation-gate'

let server: ViteDevServer | undefined
let root = ''
afterEach(async () => {
  for (const child of processes.values()) child.emit('close', 1)
  processes.clear()
  await server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})
describe('grouped training HTTP integration', () => {
  it('keeps a byte-mismatched recording interrupted and releases its operation lock', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'incomplete-record-api-'))
    server = await createServer({ configFile: false, root, plugins: [recordWriterPlugin()], server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    const base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/api/record`
    const started = await fetch(`${base}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'partial.bin', meta: { format: 'float32-le-interleaved', unit: 'uV', channels: 1, sampleRate: 250 } }) })
    const { id, stem } = await started.json()
    expect(started.status).toBe(200)
    await fetch(`${base}/${id}/chunk`, { method: 'POST', body: new Uint8Array(4) })
    const finished = await fetch(`${base}/${id}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedBytes: 8 }) })
    expect(finished.status).toBe(409)
    const folder = path.join(root, 'recordings', stem)
    expect(JSON.parse(readFileSync(path.join(folder, 'session.json'), 'utf8')).status).toBe('interrupted')
    expect(readFileSync(path.join(folder, 'eeg.bin')).length).toBe(4)
    const release = operationGate.beginModelChange()
    release()
  })
  it('validates sealed groups, persists jobs and prevents recording until the worker exits', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'grouped-training-api-'))
    server = await createServer({ configFile: false, root, plugins: [trainingPlugin()], server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    const address = server.httpServer!.address() as { port: number }
    const call = async (route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/training/${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    const created = await call('rounds', { subjectId: 'S-甲', seed: 0xffffffff })
    expect(created.status).toBe(201)
    const roundId = created.body.round.id
    const group = path.join(root, 'recordings', 'group1')
    mkdirSync(group)
    writeFileSync(path.join(group, 'session.json'), JSON.stringify({ status: 'complete', subjectId: 'S-甲', experiment: 'smr-adapt' }))
    writeFileSync(path.join(group, 'eeg.bin'), Buffer.alloc(100))
    writeFileSync(path.join(group, 'eeg.json'), JSON.stringify({ format: 'float32-le-interleaved', unit: 'uV', channels: 2, sampleRate: 250 }))
    const events = [{ type: 'trial', subjectId: 'S-甲', data: { index: 0, target: 'left' } },
      { type: 'group_end', subjectId: 'S-甲', data: { roundId, complete: false } }]
    const saveEvents = () => writeFileSync(path.join(group, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))
    saveEvents()
    const request = { kind: 'export', roundId, sessions: ['group1'], labelSource: 'trial' }
    expect((await call('jobs', request)).status).toBe(400)
    events[1]!.data.complete = true
    saveEvents()
    const exported = await call('jobs', request)
    expect(exported.status).toBe(202)
    expect(() => operationGate.assertCanRecord()).toThrow()
    expect((await call('jobs', request)).status).toBe(409)
    const jobPath = path.join(root, 'recordings', '.training', exported.body.job.id, 'job.json')
    expect(JSON.parse(readFileSync(jobPath, 'utf8')).config).toMatchObject({ subjectLabel: 'S-甲', roundId, sessions: [group] })
    const complete = (file: string) => {
      writeFileSync(path.join(path.dirname(file), 'report.json'), '{}')
      processes.get(file)!.emit('close', 0)
      processes.delete(file)
    }
    complete(jobPath)
    expect(() => operationGate.assertCanRecord()).not.toThrow()
    const result = await call(`jobs/${exported.body.job.id}`)
    expect(result.body).toMatchObject({ active: false, job: { status: 'complete' } })
    const fit = await call('jobs', { kind: 'fit', roundId, datasetId: exported.body.job.id, splitBy: 'trial',
      device: 'cpu', seed: 0xffffffff, epochs: 2, lr: .01, headId: '', modelName: 'reve-base',
      baselineRevision: 'reve-base', minimumGain: .02, maximumRecallDrop: 0 })
    expect(fit.status).toBe(202)
    expect(fit.body.job.config).toMatchObject({ baselineRevision: 'reve-base', baselineStateFile: null,
      loraCheckpoint: null, seed: 0xffffffff, minimumGain: .02, roundId })
    complete(path.join(root, 'recordings', '.training', fit.body.job.id, 'job.json'))
    const history = (await call(`rounds/${roundId}`)).body.round.entries
    expect(history.map((entry: { type: string }) => entry.type)).toEqual(['job_started', 'job_finished', 'job_started', 'job_finished'])
    const lora = { kind: 'lora', roundId, splitBy: 'trial', device: 'cpu', seed: 0xffffffff,
      epochs: 2, lr: .0001, headId: '', modelName: 'reve-base', baselineRevision: 'reve-base',
      minimumGain: .02, maximumRecallDrop: 0 }
    expect((await call('jobs', { ...lora, datasetId: exported.body.job.id })).status).toBe(400)
    expect((await call('jobs', { ...request, scope: 'history' })).status).toBe(400)
    await call(`rounds/${roundId}`, { type: 'group_saved', data: { session: 'recordings/group1', last: true } })
    const historical = await call('jobs', { ...request, scope: 'history' })
    expect(historical.status).toBe(202)
    expect(historical.body.job.config.history.rounds).toMatchObject([{ id: roundId, sessions: [group] }])
    complete(path.join(root, 'recordings', '.training', historical.body.job.id, 'job.json'))
    expect((await call('jobs', { ...lora, datasetId: historical.body.job.id, epochs: 0 })).status).toBe(400)
    const trained = await call('jobs', { ...lora, datasetId: historical.body.job.id })
    expect(trained.status).toBe(202)
    expect(trained.body.job.config).toMatchObject({ rank: 4, alpha: 8, batchSize: 1, accumulationSteps: 8,
      history: { rounds: [{ id: roundId }] }, baselineRevision: 'reve-base' })
    expect(() => operationGate.assertCanRecord()).toThrow()
    expect(trained.body.job.config.adapterOutput).toContain('.reve-adapters')
    complete(path.join(root, 'recordings', '.training', trained.body.job.id, 'job.json'))
    expect(() => operationGate.assertCanRecord()).not.toThrow()
  })
})
