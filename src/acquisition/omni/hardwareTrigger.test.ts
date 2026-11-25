import { afterEach, expect, it, vi } from 'vitest'
import {
  authorizeHardwareTriggerDirectory, authorizeHardwareTriggerPort, hardwareTriggerAck,
  openHardwareTrigger, prepareHardwareTrigger, stm32TriggerFrame,
} from './hardwareTrigger'

const SESSION = '261120_181209'
const TIME = new Date('2026-11-20T10:12:10Z')
const deviceEvent = {
  session_id: SESSION, code: 120, label: 'stm32_hardware_trigger',
  host_time: TIME.toISOString(), sequence: 22, sample_index: 21,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('encodes the SDK binary trigger frame and validates the event byte', () => {
  expect([...stm32TriggerFrame(120)]).toEqual([0xa5, 120, 135])
  expect([...stm32TriggerFrame(255)]).toEqual([0xa5, 255, 0])
  expect(() => stm32TriggerFrame(256)).toThrow(RangeError)
})

it('only matches a new device marker with the expected session and code', () => {
  const records = [
    { ...deviceEvent, label: 'pbc1|focus' },
    { ...deviceEvent, session_id: 'another-session' },
    { ...deviceEvent, code: 130 },
    { ...deviceEvent, host_time: '2026-11-20T10:12:00Z' },
  ]
  const lines = records.map(row => JSON.stringify(row)).join('\n')
  expect(hardwareTriggerAck(lines, 120, SESSION, TIME.getTime())).toBeUndefined()
  expect(hardwareTriggerAck(`${lines}\n${JSON.stringify(deviceEvent)}`, 120, SESSION, TIME.getTime()))
    .toMatchObject({ accepted: true, sequence: 22, sample_index: 21 })
})

it('writes to a mock CH340 and waits for a complete device event in the current GUI journal', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(TIME)
  const line = JSON.stringify(deviceEvent)
  let content = `${line}\n`
  const write = vi.fn(async (frame: Uint8Array) => {
    expect([...frame]).toEqual([0xa5, 120, 135])
    content += line.slice(0, 20)
  })
  let writable: WritableStream<Uint8Array> | null = null
  const port = {
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    get writable() { return writable },
    open: vi.fn(async () => { writable = new WritableStream<Uint8Array>({ write }) }),
  }
  const getFileHandle = vi.fn(async () => ({ getFile: async () => new Blob([content]) }))
  const requestPort = vi.fn(async () => port)
  vi.stubGlobal('navigator', { serial: { getPorts: async () => [port], requestPort } })
  vi.stubGlobal('window', { showDirectoryPicker: async () => ({
    name: 'recordings', queryPermission: async () => 'granted', getFileHandle,
  }) })
  await authorizeHardwareTriggerPort()
  await authorizeHardwareTriggerDirectory()
  expect(requestPort).toHaveBeenCalledWith({ filters: [{ usbVendorId: 0x1a86, usbProductId: 0x7523 }] })
  const preparation = await prepareHardwareTrigger({ code: 120, sessionId: SESSION, signal: new AbortController().signal })
  expect(port.open).toHaveBeenCalledWith({ baudRate: 10000 })
  expect(getFileHandle).toHaveBeenCalledWith(`${SESSION}_events.jsonl`)
  expect(write).not.toHaveBeenCalled()
  const done = vi.fn()
  if (!('send' in preparation)) throw new Error(preparation.message)
  const result = preparation.send().then(done)
  await vi.advanceTimersByTimeAsync(40)
  expect(done).not.toHaveBeenCalled()
  content += `${line.slice(20)}\n`
  await vi.advanceTimersByTimeAsync(40)
  await result
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ accepted: true, sequence: 22, sample_index: 21 }))
  expect(write).toHaveBeenCalledOnce()
})

it('reports the selected directory and missing current journal before opening the port', async () => {
  const getPorts = vi.fn()
  vi.stubGlobal('navigator', { serial: { getPorts } })
  vi.stubGlobal('window', { showDirectoryPicker: async () => ({
    name: 'Shinan', queryPermission: async () => 'granted',
    getFileHandle: async () => { throw new DOMException('No such file', 'NotFoundError') },
  }) })
  await authorizeHardwareTriggerDirectory()
  const result = await prepareHardwareTrigger({ code: 245, sessionId: SESSION, signal: new AbortController().signal })
  expect(result).toMatchObject({
    reason: 'journal_not_found', message: expect.stringContaining(`「Shinan」里没有 ${SESSION}_events.jsonl`),
  })
  expect(getPorts).not.toHaveBeenCalled()
})

it('writes consecutive identical markers before reading their delayed journal confirmations', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(TIME)
  let content = ''
  const write = vi.fn()
  const port = {
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    writable: new WritableStream<Uint8Array>({ write }),
  }
  const getFile = vi.fn(async () => new Blob([content]))
  const getPorts = vi.fn(async () => [port])
  const queryPermission = vi.fn(async () => 'granted')
  vi.stubGlobal('navigator', { serial: { getPorts } })
  vi.stubGlobal('window', { showDirectoryPicker: async () => ({
    queryPermission, getFileHandle: async () => ({ getFile }),
  }) })
  await authorizeHardwareTriggerDirectory()
  const signal = new AbortController().signal
  const link = await openHardwareTrigger({ sessionId: SESSION, signal })
  if (!('send' in link)) throw new Error(link.message)
  const confirmed = vi.fn()
  const first = link.send(120, signal).then(confirmed)
  const second = link.send(120, signal).then(confirmed)
  await vi.advanceTimersByTimeAsync(0)
  expect(write.mock.calls.map(([bytes]) => [...bytes])).toEqual([[0xa5, 120, 135], [0xa5, 120, 135]])
  expect(queryPermission).toHaveBeenCalledOnce()
  expect(getPorts).toHaveBeenCalledOnce()
  expect(getFile).toHaveBeenCalledOnce()

  content += `${JSON.stringify(deviceEvent)}\n`
  await vi.advanceTimersByTimeAsync(40)
  expect(confirmed).not.toHaveBeenCalled()
  content += `${JSON.stringify({ ...deviceEvent, sequence: 23, sample_index: 22 })}\n`
  await vi.advanceTimersByTimeAsync(40)
  await Promise.all([first, second])
  expect(confirmed.mock.calls.map(([event]) => event.sequence)).toEqual([22, 23])
})
