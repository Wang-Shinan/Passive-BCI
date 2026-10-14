import { expect, it } from 'vitest'
import { omniElectrodePositions, sphericalToCartesian, validElectrodePositions } from './positions'

it('converts degree-based azimuth/elevation in metres without guessing a head radius', () => {
  expect(sphericalToCartesian(0, 0, 0.1)).toEqual([0.1, 0, 0])
  const forward = sphericalToCartesian(90, 0, 0.1)
  expect(forward[0]).toBeCloseTo(0)
  expect(forward[1]).toBeCloseTo(0.1)
  const top = sphericalToCartesian(20, 90, 0.09)
  expect(top[0]).toBeCloseTo(0)
  expect(top[1]).toBeCloseTo(0)
  expect(top[2]).toBeCloseTo(0.09)
})

it('keeps incomplete/2D/non-finite input invalid and rejects duplicate positions', () => {
  expect(omniElectrodePositions({ positionMode: 'standard' })).toBeUndefined()
  for (const row of [['', '0', '0.1'], ['0', '0'], ['0', '91', '0.1'], ['0', '0', '0'], ['0', '0', 'Infinity']]) {
    expect(omniElectrodePositions({ positionMode: 'spherical', positionCoordinates: Array(8).fill(row) })).toEqual([])
  }
  expect(validElectrodePositions(Array(8).fill([0, 0, 0.1]))).toBe(false)
  const positions = omniElectrodePositions({ positionMode: 'spherical', positionCoordinates:
    Array.from({ length: 8 }, (_, i) => [String(i * 45), '20', '0.1']) })
  expect(validElectrodePositions(positions)).toBe(true)
})
