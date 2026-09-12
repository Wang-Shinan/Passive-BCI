import { describe, expect, it, vi } from 'vitest'
import {
  BinRecorder,
  RECORD_FLUSH_BYTES,
  formatRecordBytes,
  recordFilename,
  type RecordSink,
} from './recorder'

function capturingSink(): { sink: RecordSink; writes: Uint8Array[] } {
  const writes: Uint8Array[] = []
  const sink: RecordSink = {
    kind: 'memory',
    async write(chunk) {
      writes.push(chunk.slice())
    },
    async finish() {
      return { name: 't.bin' }
    },
    async abort() {},
  }
  return { sink, writes }
}

describe('recordFilename', () => {
  it('keeps a safe basename', () => {
    expect(recordFilename('neuracle_eeg', '0817_170233')).toBe('neuracle_eeg_0817_170233.bin')
  })

  it('strips path characters', () => {
    expect(recordFilename('../evil/name', 'id')).toBe('evil_name_id.bin')
  })
})

describe('formatRecordBytes', () => {
  it('formats KB and MB', () => {
    expect(formatRecordBytes(512)).toBe('512 B')
    expect(formatRecordBytes(2048)).toBe('2.0 KB')
    expect(formatRecordBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})

describe('RECORD_FLUSH_BYTES', () => {
  it('stays small enough for live control (~125 ms at 64 ch / 1 kHz)', () => {
    expect(RECORD_FLUSH_BYTES).toBe(32 * 1024)
  })
})

describe('BinRecorder', () => {
  it('coalesces tiny frames into flush-sized writes', async () => {
    const { sink, writes } = capturingSink()
    const rec = new BinRecorder({
      flushBytes: 64,
      createSink: async () => sink,
    })
    await rec.start({ filenamePrefix: 't' })
    rec.append(new Uint8Array(40).fill(1))
    rec.append(new Uint8Array(40).fill(2))
    expect(rec.byteLength).toBe(80)
    const saved = await rec.stop()
    expect(saved?.bytes).toBe(80)
    expect(writes).toHaveLength(2)
    expect(writes[0]!.byteLength).toBe(64)
    expect(writes[1]!.byteLength).toBe(16)
    expect([...writes[0]!.subarray(0, 40)]).toEqual(Array(40).fill(1))
    expect([...writes[0]!.subarray(40)]).toEqual(Array(24).fill(2))
  })

  it('does not keep per-frame allocations after a flush', async () => {
    const { sink, writes } = capturingSink()
    const rec = new BinRecorder({
      flushBytes: 48,
      createSink: async () => sink,
    })
    await rec.start({ filenamePrefix: 'omni' })
    for (let i = 0; i < 10; i++) rec.append(new Uint8Array(48).fill(i))
    await rec.stop()
    expect(writes).toHaveLength(10)
    expect(writes.every((w) => w.byteLength === 48)).toBe(true)
  })

  it('returns null and aborts when nothing was written', async () => {
    const abort = vi.fn(async () => {})
    const rec = new BinRecorder({
      createSink: async () => ({
        kind: 'disk',
        write: async () => {},
        finish: async () => ({ name: 'empty.bin' }),
        abort,
      }),
    })
    await rec.start({ filenamePrefix: 'empty' })
    expect(await rec.stop()).toBeNull()
    expect(abort).toHaveBeenCalled()
  })

  it('discard aborts the sink and clears recording', async () => {
    const abort = vi.fn(async () => {})
    const rec = new BinRecorder({
      createSink: async () => ({
        kind: 'memory',
        write: async () => {},
        finish: async () => ({ name: 'x.bin' }),
        abort,
      }),
    })
    await rec.start({ filenamePrefix: 'x' })
    rec.append(new Uint8Array([1, 2, 3]))
    await rec.discard()
    expect(rec.recording).toBe(false)
    expect(rec.byteLength).toBe(0)
    expect(abort).toHaveBeenCalled()
  })

  it('falls back to memory when the disk API is missing', async () => {
    const rec = new BinRecorder({ flushBytes: 32 })
    const kind = await rec.start({ filenamePrefix: 't' })
    expect(kind).toBe('memory')
    rec.append(new Uint8Array(8).fill(9))
    const saved = await rec.stop()
    expect(saved?.sink).toBe('memory')
    expect(saved?.bytes).toBe(8)
  })

  it('counts unflushed bytes while a sink write is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = new BinRecorder({
      flushBytes: 8,
      createSink: async () => ({
        kind: 'disk',
        write: () => gate,
        finish: async () => ({ name: 't.bin' }),
        abort: async () => {},
      }),
    })
    await rec.start({ filenamePrefix: 't' })
    rec.append(new Uint8Array(8).fill(1))
    expect(rec.pendingBytes).toBe(8)
    release()
    const saved = await rec.stop()
    expect(saved?.bytes).toBe(8)
    expect(rec.pendingBytes).toBe(0)
  })
})
