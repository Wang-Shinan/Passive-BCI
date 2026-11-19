import { afterEach, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connect } from 'vite'
import { recordWriterPlugin } from './vite.record-writer'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'passive-bci-record-interrupt-'))
  roots.push(root)
  let middleware: Connect.NextHandleFunction
  const plugin = recordWriterPlugin()
  const hook = plugin.configurePreviewServer
  if (typeof hook !== 'function') throw new Error('missing preview hook')
  hook.call({} as never, { config: { root }, middlewares: { use(fn: Connect.NextHandleFunction) { middleware = fn } } } as never)
  function request(path: string, method = 'POST', body?: string | Buffer) {
    const stream = Object.assign(new PassThrough(), { url: path, method })
    const response = { statusCode: 200, setHeader() {}, end(_value: string) {} }
    const done = new Promise<{ status: number; body: Record<string, unknown> }>(resolve => {
      response.end = value => resolve({ status: response.statusCode, body: JSON.parse(value) })
    })
    middleware!(stream as never, response as never, () => { throw new Error('unexpected next') })
    if (body !== undefined) stream.end(body)
    return { stream, done }
  }
  return { root, request }
}

it('an intentionally interrupted finish saves with status interrupted, reason and HTTP 200', async () => {
  const { root, request } = setup()
  const started = await request('/api/record/start', 'POST', '{"filename":"seg_a.bin"}').done
  const id = started.body.id as string
  await request(`/api/record/${id}/chunk`, 'POST', Buffer.alloc(16, 7)).done
  const result = await request(
    `/api/record/${id}/finish`,
    'POST',
    JSON.stringify({ interrupted: true, interruptionReason: 'conflict', expectedBytes: 16 }),
  ).done
  expect(result.status).toBe(200)
  expect(result.body.ok).toBe(true)
  const manifest = JSON.parse(readFileSync(join(root, 'recordings/seg_a/session.json'), 'utf8'))
  expect(manifest.status).toBe('interrupted')
  expect(manifest.interruption.reason).toBe('conflict')
  const sidecar = JSON.parse(readFileSync(join(root, 'recordings/seg_a/eeg.json'), 'utf8'))
  expect(sidecar.status).toBe('interrupted')
  expect(sidecar.interruptionReason).toBe('conflict')
  expect(readFileSync(join(root, 'recordings/seg_a/eeg.bin'))).toEqual(Buffer.alloc(16, 7))
})

it('a second segment in the same second gets a unique stem instead of overwriting', async () => {
  const { root, request } = setup()
  const first = await request('/api/record/start', 'POST', '{"filename":"seg.bin"}').done
  const firstId = first.body.id as string
  await request(`/api/record/${firstId}/chunk`, 'POST', Buffer.alloc(4, 1)).done
  await request(`/api/record/${firstId}/finish`, 'POST', '{"interrupted":true,"interruptionReason":"conflict"}').done
  const second = await request('/api/record/start', 'POST', '{"filename":"seg.bin"}').done
  const secondId = second.body.id as string
  await request(`/api/record/${secondId}/chunk`, 'POST', Buffer.alloc(4, 2)).done
  const done = await request(`/api/record/${secondId}/finish`, 'POST', '{}').done
  expect(done.status).toBe(200)
  expect(done.body.rel).not.toBe('recordings/seg')
  expect(done.body.rel).toBe('recordings/seg_2')
  const oldManifest = JSON.parse(readFileSync(join(root, 'recordings/seg/session.json'), 'utf8'))
  expect(oldManifest.status).toBe('interrupted')
  const newManifest = JSON.parse(readFileSync(join(root, 'recordings/seg_2/session.json'), 'utf8'))
  expect(newManifest.status).toBe('complete')
})

it('incomplete IO still returns 409 even when flagged interrupted', async () => {
  const { request } = setup()
  const started = await request('/api/record/start', 'POST', '{"filename":"badseg.bin"}').done
  const id = started.body.id as string
  await request(`/api/record/${id}/chunk`, 'POST', Buffer.alloc(8, 3)).done
  const result = await request(
    `/api/record/${id}/finish`,
    'POST',
    JSON.stringify({ interrupted: true, incomplete: true, expectedBytes: 8 }),
  ).done
  expect(result.status).toBe(409)
})
