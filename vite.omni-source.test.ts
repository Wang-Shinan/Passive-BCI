import { expect, it } from 'vitest'
import { parseOmniModelSource } from './vite.omni-source'

it('keeps the original device endpoint and explicit channel order', () => {
  const source = { endpoint: 'ble://PeripheralId(test)', channelNames: ['F3', 'F4', 'C3', 'Cz', 'C4', 'P3', 'Pz', 'P4'] }
  expect(parseOmniModelSource(source)).toEqual(source)
  expect(parseOmniModelSource(undefined)).toBeNull()
})
it('rejects placeholders, duplicate electrodes and non-BLE endpoints before spawning', () => {
  expect(() => parseOmniModelSource({ endpoint: 'ble://test', channelNames: Array.from({ length: 8 }, (_, i) => `CH${i + 1}`) })).toThrow('真实电极')
  expect(() => parseOmniModelSource({ endpoint: 'ble://test', channelNames: Array(8).fill('C3') })).toThrow()
  expect(() => parseOmniModelSource({ endpoint: 'https://example.org' })).toThrow()
})

it('accepts CH labels with independent named or XYZ electrode positions', () => {
  const source = { endpoint: 'ble://test', channelNames: Array.from({ length: 8 }, (_, i) => `CH${i + 1}`) }
  const electrodeNames = ['F3', 'F4', 'C3', 'Cz', 'C4', 'P3', 'Pz', 'P4']
  expect(parseOmniModelSource({ ...source, electrodeNames })).toEqual({ ...source, electrodeNames })
  const electrodePositions = Array.from({ length: 8 }, (_, i) => [i * 0.01, 0, 0.08])
  expect(parseOmniModelSource({ ...source, electrodePositions })).toEqual({ ...source, electrodePositions })
  expect(() => parseOmniModelSource({ ...source, electrodePositions: [] })).toThrow()
  expect(() => parseOmniModelSource({ ...source, electrodeNames: ['C3'] })).toThrow()
})
