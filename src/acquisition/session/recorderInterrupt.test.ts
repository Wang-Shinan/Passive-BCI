import { describe, expect, it } from 'vitest'
import { BinRecorder, type RecordFinishExtra, type RecordSink } from './recorder'

function capturingSink(opts?: { failWrite?: boolean }) {
  const writes: Uint8Array[] = []
  const finishes: RecordFinishExtra[] = []
  const sink: RecordSink & { failWrite?: boolean } = {
    kind: 'memory',
    failWrite: opts?.failWrite,
    async write(chunk) {
      if (this.failWrite) throw new Error('disk full')
      writes.push(chunk.slice())
    },
    async finish(extra) {
      finishes.push(extra ?? {})
      return { name: 't.bin' }
    },
    async abort() {},
  }
  return { sink, writes, finishes }
}

describe('BinRecorder intentional interruption', () => {
  it('saves an interrupted segment successfully when IO is good', async () => {
    const { sink, finishes } = capturingSink()
    const rec = new BinRecorder({ flushBytes: 8, createSink: async () => sink })
    await rec.start({ filenamePrefix: 'seg' })
    rec.append(new Uint8Array(16).fill(1))
    const saved = await rec.stop({ interrupted: true, interruptionReason: 'transport' })
    expect(saved?.error).toBeUndefined()
    expect(saved?.bytes).toBe(16)
    expect(saved?.interrupted).toBe(true)
    expect(finishes[0]?.interrupted).toBe(true)
    expect(finishes[0]?.interruptionReason).toBe('transport')
    expect(finishes[0]?.incomplete).toBe(false)
  })

  it('keeps no-argument stop behavior unchanged', async () => {
    const { sink, finishes } = capturingSink()
    const rec = new BinRecorder({ flushBytes: 8, createSink: async () => sink })
    await rec.start({ filenamePrefix: 'seg' })
    rec.append(new Uint8Array(8).fill(1))
    const saved = await rec.stop()
    expect(saved?.interrupted).toBeUndefined()
    expect(finishes[0]?.interrupted).toBe(false)
    expect(finishes[0]?.interruptionReason).toBeUndefined()
  })

  it('still reports an error when flush IO failed even if flagged interrupted', async () => {
    const { sink } = capturingSink({ failWrite: true })
    const rec = new BinRecorder({ flushBytes: 8, createSink: async () => sink })
    await rec.start({ filenamePrefix: 'seg' })
    rec.append(new Uint8Array(16).fill(1))
    const saved = await rec.stop({ interrupted: true, interruptionReason: 'transport' })
    expect(saved?.error).toBeTruthy()
  })

  it('accepts no samples after the freeze boundary', async () => {
    const { sink, writes } = capturingSink()
    const rec = new BinRecorder({ flushBytes: 8, createSink: async () => sink })
    await rec.start({ filenamePrefix: 'seg' })
    rec.append(new Uint8Array(8).fill(1))
    const stopping = rec.stop({ interrupted: true })
    rec.append(new Uint8Array(8).fill(9))
    const saved = await stopping
    expect(saved?.bytes).toBe(8)
    const total = writes.reduce((n, c) => n + c.byteLength, 0)
    expect(total).toBe(8)
  })

  it('a duplicate stop joins the in-flight close; a new start waits for it', async () => {
    const finishes: RecordFinishExtra[] = []
    let finishWrites: Uint8Array[] = []
    const first: RecordSink = {
      kind: 'disk',
      async write(chunk) { finishWrites.push(chunk.slice()) },
      async finish(extra) {
        await new Promise((r) => setTimeout(r, 0))
        finishes.push(extra ?? {})
        return { name: 'old.bin' }
      },
      async abort() {},
    }
    const second: RecordSink = {
      kind: 'disk',
      async write(chunk) { finishWrites.push(chunk.slice()) },
      async finish() { return { name: 'new.bin' } },
      async abort() {},
    }
    const sinks = [first, second]
    const rec = new BinRecorder({ flushBytes: 8, createSink: async () => sinks.shift()! })
    await rec.start({ filenamePrefix: 'seg' })
    rec.append(new Uint8Array(8).fill(1))
    const stopA = rec.stop()
    const stopB = rec.stop()
    const startNew = rec.start({ filenamePrefix: 'seg' })
    const [saved, savedB] = await Promise.all([stopA, stopB])
    expect(savedB).toBe(saved)
    expect(finishes).toHaveLength(1)
    expect(saved?.name).toBe('old.bin')
    await startNew
    expect(rec.recording).toBe(true)
    finishWrites = []
    rec.append(new Uint8Array(8).fill(2))
    const savedNew = await rec.stop()
    expect(savedNew?.name).toBe('new.bin')
    expect(finishWrites.reduce((n, c) => n + c.byteLength, 0)).toBe(8)
  })

  it('supports sequential segments: restart options survive an interrupted stop', async () => {
    const { sink } = capturingSink()
    const filenames: string[] = []
    const rec = new BinRecorder({
      flushBytes: 8,
      createSink: async ({ filename }) => { filenames.push(filename); return sink },
    })
    const meta = { device: 'omni', format: 'float32-le-interleaved' }
    await rec.start({ filenamePrefix: 'seg', meta })
    const restart = rec.restartOptions
    rec.append(new Uint8Array(8).fill(1))
    const first = await rec.stop({ interrupted: true, interruptionReason: 'conflict' })
    expect(first?.error).toBeUndefined()
    expect(restart.filenamePrefix).toBe('seg')
    await rec.start({ ...restart, meta: { ...restart.meta, previousSegmentName: first?.name } })
    rec.append(new Uint8Array(8).fill(2))
    const second = await rec.stop()
    expect(second?.error).toBeUndefined()
    expect(filenames).toHaveLength(2)
  })
})
