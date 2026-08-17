import { describe, expect, it } from 'vitest'
import { SampleClock } from './sampleClock'

describe('SampleClock', () => {
  it('maps device_end_ms onto the browser clock with a lower envelope', () => {
    const clock = new SampleClock()
    clock.noteBatch({ samples: 25, sampleRate: 250, arrivalNowMs: 1000, deviceEndMs: 500 })
    expect(clock.snapshot()?.acquiredNowMs).toBe(1000)
    expect(clock.pipelineDelayMs()).toBe(0)

    clock.noteBatch({ samples: 25, sampleRate: 250, arrivalNowMs: 1140, deviceEndMs: 600 })
    const snap = clock.snapshot()
    expect(snap?.source).toBe('device')
    expect(snap?.acquiredNowMs).toBe(1100)
    expect(snap?.pipelineDelayMs).toBeCloseTo(40)
    expect(snap?.sampleIndex).toBe(50)
  })

  it('does not let a delayed packet pull the envelope backward in time', () => {
    const clock = new SampleClock()
    clock.noteBatch({ samples: 10, sampleRate: 250, arrivalNowMs: 2000, deviceEndMs: 100 })
    clock.noteBatch({ samples: 10, sampleRate: 250, arrivalNowMs: 2200, deviceEndMs: 140 })
    expect(clock.snapshot()?.acquiredNowMs).toBe(2040)
    expect(clock.pipelineDelayMs()).toBeCloseTo(160)
  })

  it('falls back to arrival time when the device clock is absent', () => {
    const clock = new SampleClock()
    clock.noteBatch({ samples: 8, sampleRate: 250, arrivalNowMs: 50 })
    const snap = clock.snapshot()
    expect(snap?.source).toBe('arrival')
    expect(snap?.acquiredNowMs).toBe(50)
    expect(snap?.pipelineDelayMs).toBe(0)
  })

  it('unwraps a 32-bit device millisecond wrap', () => {
    const clock = new SampleClock()
    const wrap = 2 ** 32
    clock.noteBatch({
      samples: 1,
      sampleRate: 250,
      arrivalNowMs: 10_000,
      deviceEndMs: wrap - 20,
    })
    clock.noteBatch({
      samples: 1,
      sampleRate: 250,
      arrivalNowMs: 10_040,
      deviceEndMs: 20,
    })
    const dump = clock.dump()
    expect(dump.batches[1]!.deviceEndMs).toBeCloseTo(wrap + 20)
  })

  it('estimates a sample index from an acquisition-time query', () => {
    const clock = new SampleClock()
    clock.noteBatch({ samples: 25, sampleRate: 250, arrivalNowMs: 1000, deviceEndMs: 0 })
    const atArrival = clock.sampleIndexAt(1000)
    expect(atArrival).toBeCloseTo(25)
    const later = clock.sampleIndexAt(1100)
    expect(later).toBeCloseTo(50)
  })
})
