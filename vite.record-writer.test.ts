import { describe, expect, it } from 'vitest'
import { safeRecordFilename, safeSessionStem } from './vite.record-writer'

describe('safeSessionStem', () => {
  it('strips .bin and path characters', () => {
    expect(safeSessionStem('../evil/neuracle_eeg_0817_171004.bin')).toBe(
      'neuracle_eeg_0817_171004',
    )
    expect(safeRecordFilename('neuracle_eeg_0817_171004.bin')).toBe(
      'neuracle_eeg_0817_171004.bin',
    )
  })

  it('falls back when empty', () => {
    expect(safeSessionStem('...')).toBe('session')
  })
})
