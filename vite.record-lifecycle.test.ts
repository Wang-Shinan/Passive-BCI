import { afterEach, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connect } from 'vite'
import { recordWriterPlugin } from './vite.record-writer'
import { operationGate } from './vite.operation-gate'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'passive-bci-record-lifecycle-'))
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

it('finishing waits for accepted request bodies and refuses new chunks before releasing the model lock', async () => {
  const { root, request } = setup()
  const started = await request('/api/record/start', 'POST', '{"filename":"lifecycle.bin"}').done
  const id = started.body.id as string
  expect(() => operationGate.beginModelChange()).toThrow('录制')
  const chunk = request(`/api/record/${id}/chunk`)
  chunk.stream.write(Buffer.alloc(8, 1))
  const finish = request(`/api/record/${id}/finish`, 'POST', '{"incomplete":true}')
  let finished = false
  void finish.done.then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(finished).toBe(false)
  expect((await request(`/api/record/${id}/chunk`, 'POST', Buffer.alloc(4)).done).status).toBe(409)
  chunk.stream.end(Buffer.alloc(8, 2))
  expect((await chunk.done).status).toBe(200)
  const result = await finish.done
  expect(result.status).toBe(409)
  expect(result.body.bytes).toBe(16)
  const manifest = JSON.parse(readFileSync(join(root, 'recordings/lifecycle/session.json'), 'utf8'))
  expect(manifest.status).toBe('interrupted')
  expect(readFileSync(join(root, 'recordings/lifecycle/eeg.bin'))).toEqual(Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(8, 2)]))
  expect((await request('/api/record/active', 'GET', '').done).body.id).toBeNull()
  const release = operationGate.beginModelChange()
  release()
})
