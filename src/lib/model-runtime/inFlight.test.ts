import { describe, expect, it } from 'vitest'
import { collectExpiredInFlight, inFlightTimeoutMs } from './inFlight'

describe('inFlightTimeoutMs', () => {
  it('uses 8 hops, with a 4s floor', () => {
    expect(inFlightTimeoutMs(0.5)).toBe(4000)
    expect(inFlightTimeoutMs(0.1)).toBe(4000)
  })
})

describe('collectExpiredInFlight', () => {
  it('returns only ids older than the timeout', () => {
    const sentAt: Array<[string, number]> = [
      ['a', 1000],
      ['b', 1800],
      ['c', 2500],
    ]
    expect(collectExpiredInFlight(sentAt, 3000, 1500)).toEqual(['a'])
    expect(collectExpiredInFlight(sentAt, 3800, 2000)).toEqual(['a', 'b'])
    expect(collectExpiredInFlight(sentAt, 3000, 4000)).toEqual([])
  })
})
