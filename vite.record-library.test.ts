import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { crc32, zipStoreBuffers } from './vite.record-zip'
import {
  countNdjsonLines,
  estimateDurationSec,
  eventTypeHistogram,
  listSessionSummaries,
  patchSessionManifest,
  summarizeSessionDir,
  zipSessionDir,
} from './vite.record-library'

describe('zip store', () => {
  it('writes PK signatures and preserves payload', () => {
    const zip = zipStoreBuffers([{ name: 'hello.txt', data: Buffer.from('abc') }])
    expect(zip.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004')
    expect(zip.includes(Buffer.from('hello.txt'))).toBe(true)
    expect(zip.includes(Buffer.from('abc'))).toBe(true)
    expect(crc32(Buffer.from('abc'))).toBe(0x352441c2)
  })
})

describe('session library', () => {
  it('summarizes a finished tetris folder and packs a zip', () => {
    const root = mkdtempSync(join(tmpdir(), 'pbci-rec-'))
    const stem = 'bcigo_tetris_S01_0817_194500'
    const dir = join(root, stem)
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'session.json'),
      JSON.stringify({
        schema: 'passive-bci.session.v1',
        id: 'rtestfolder',
        dir: stem,
        startedAt: '2026-08-17T11:45:00.000Z',
        stoppedAt: '2026-08-17T11:50:00.000Z',
        status: 'complete',
        experiment: 'tetris',
        subjectId: 'S01',
        eeg: { device: 'bcigo', format: 'float32-le-interleaved', sampleRate: 250, channels: 32 },
      }),
    )
    writeFileSync(join(dir, 'eeg.bin'), Buffer.alloc(32 * 250 * 4 * 2))
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${JSON.stringify({ type: 'spawn' })}\n${JSON.stringify({ type: 'lock' })}\n`,
    )
    writeFileSync(join(dir, 'context.jsonl'), `${JSON.stringify({ score: 0 })}\n`)

    const summary = summarizeSessionDir(root, stem)
    expect(summary?.experiment).toBe('tetris')
    expect(summary?.subjectId).toBe('S01')
    expect(summary?.events).toBe(2)
    expect(summary?.eventTypes.lock).toBe(1)
    expect(summary?.status).toBe('complete')
    expect(summary?.durationSec).toBe(300)

    const patched = patchSessionManifest(root, stem, { notes: 'block 1' })
    expect(patched?.notes).toBe('block 1')

    const zip = zipSessionDir(root, stem)
    expect(zip?.subarray(0, 2).toString()).toBe('PK')
  })

  it('marks abandoned recordings as interrupted', () => {
    const root = mkdtempSync(join(tmpdir(), 'pbci-rec-'))
    const stem = 'bcigo_eeg_0817_191533'
    mkdirSync(join(root, stem))
    writeFileSync(
      join(root, stem, 'session.json'),
      JSON.stringify({ status: 'recording', startedAt: '2026-08-17T11:15:00.000Z', dir: stem }),
    )
    writeFileSync(join(root, stem, 'eeg.bin'), Buffer.alloc(16))
    const listed = listSessionSummaries(root)
    expect(listed[0]?.status).toBe('interrupted')
  })

  it('counts ndjson and estimates EEG duration', () => {
    expect(countNdjsonLines(Buffer.from('a\nb\n'))).toBe(2)
    expect(countNdjsonLines(Buffer.from('a\nb'))).toBe(2)
    expect(eventTypeHistogram(Buffer.from('{"type":"spawn"}\n{"type":"spawn"}\n')).spawn).toBe(2)
    expect(
      estimateDurationSec(
        { format: 'float32-le-interleaved', sampleRate: 250, channels: 32 },
        32 * 250 * 4 * 10,
        null,
        null,
      ),
    ).toBe(10)
  })
})
