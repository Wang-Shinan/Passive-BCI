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

it('requires the explicit STM32 type and all 32 electrode positions', () => {
  const source = { endpoint: 'ble://32', deviceType: 'stm32',
    channelNames: Array.from({ length: 32 }, (_, i) => `CH${i + 1}`),
    electrodePositions: Array.from({ length: 32 }, (_, i) => [i * .001, 0, .08]) }
  expect(parseOmniModelSource(source)).toEqual(source)
  expect(() => parseOmniModelSource({ ...source, deviceType: undefined })).toThrow('8')
  expect(() => parseOmniModelSource({ ...source, electrodePositions: source.electrodePositions.slice(0, 8) })).toThrow('32')
  expect(() => parseOmniModelSource({ ...source, deviceType: 'auto' })).toThrow('设备类型')
})
