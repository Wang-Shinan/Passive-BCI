import '../transport/webSerial'

const CH340 = { usbVendorId: 0x1a86, usbProductId: 0x7523 }
const STM32_TRIGGER_BAUD = 10_000
const JOURNAL_POLL_MS = 40
const JOURNAL_READ_BYTES = 64 * 1024
const DIRECTORY_KEY = 'gui-recordings'

type TriggerDirectory = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>
}
type TriggerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'read' }) => Promise<TriggerDirectory>
}
export type HardwareTriggerFailure = { reason: string; message: string }
type HardwareTriggerPreparation = { send: () => Promise<unknown> } | HardwareTriggerFailure
export type PrepareHardwareTrigger = (
  request: { code: number; sessionId: string; signal: AbortSignal },
) => Promise<HardwareTriggerPreparation>
export type HardwareTriggerLink = {
  send: (code: number, signal: AbortSignal) => Promise<unknown>
}
export type OpenHardwareTrigger = (
  request: { sessionId: string; signal: AbortSignal },
) => Promise<HardwareTriggerLink | HardwareTriggerFailure>

let selectedPort: SerialPort | undefined
let directory: Promise<TriggerDirectory | undefined> | undefined

function isCh340(port: SerialPort): boolean {
  const info = port.getInfo()
  return info.usbVendorId === CH340.usbVendorId && info.usbProductId === CH340.usbProductId
}

export async function authorizeHardwareTriggerPort(): Promise<void> {
  const serial = navigator.serial
  if (!serial) throw new Error('请使用支持 Web Serial 的 Chrome 或 Edge。')
  selectedPort = await serial.requestPort({ filters: [CH340] })
}

async function directoryStore(handle?: TriggerDirectory): Promise<TriggerDirectory | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('passive-bci-hardware-trigger', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('permissions')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('permissions', handle ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('permissions')
      const request = handle ? store.put(handle, DIRECTORY_KEY) : store.get(DIRECTORY_KEY)
      transaction.oncomplete = () => resolve(handle ?? request.result as TriggerDirectory | undefined)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

function getDirectory(): Promise<TriggerDirectory | undefined> {
  return directory ??= directoryStore().catch(() => undefined)
}

export async function hardwareTriggerDirectoryName(): Promise<string | undefined> {
  return (await getDirectory())?.name
}

export async function authorizeHardwareTriggerDirectory(): Promise<string> {
  const picker = (window as TriggerWindow).showDirectoryPicker
  if (!picker) throw new Error('请使用支持目录授权的 Chrome 或 Edge。')
  const handle = await picker.call(window, { mode: 'read' })
  directory = Promise.resolve(handle)
  await directoryStore(handle).catch(() => undefined)
  return handle.name
}

export function stm32TriggerFrame(code: number): Uint8Array {
  if (!Number.isInteger(code) || code < 0 || code > 255) throw new RangeError('STM32 trigger code must be a byte')
  return Uint8Array.of(0xa5, code, code ^ 0xff)
}

/** Match only newly recorded device events, never HTTP triggers or old events. */
export function hardwareTriggerAck(lines: string, code: number, sessionId: string, sentAt: number): unknown {
  const matches = journalEvents(lines, sessionId).filter(event => event.code === code && event.hostTime >= sentAt)
  if (matches.length > 1) throw new Error('ambiguous_hardware_trigger_ack')
  const event = matches[0]
  return event && { ...event.row, label: undefined, accepted: true }
}

type JournalEvent = { code: number; hostTime: number; row: Record<string, unknown> }

function journalEvents(lines: string, sessionId: string): JournalEvent[] {
  const events: JournalEvent[] = []
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) } catch { continue }
    if (row?.session_id !== sessionId || typeof row.code !== 'number' ||
        typeof row.label !== 'string' || !/^stm32_hardware_trigger(?:$|\s)/.test(row.label) ||
        typeof row.host_time !== 'string') continue
    const hostTime = Date.parse(row.host_time)
    if (Number.isFinite(hostTime)) events.push({ code: row.code, hostTime, row })
  }
  return events
}

type PendingMarker = {
  code: number
  sentAt: number
  resolve: (event: unknown) => void
  reject: (error: unknown) => void
}

function createHardwareLink(writable: WritableStream<Uint8Array>, journal: FileSystemFileHandle, offset: number, sessionId: string): HardwareTriggerLink {
  const pending = new Set<PendingMarker>()
  const rows = new Map<number, JournalEvent[]>()
  const decoder = new TextDecoder()
  let polling = false
  let failure: unknown

  const fail = (error: unknown) => {
    failure = error
    for (const marker of pending) marker.reject(error)
    rows.clear()
  }

  const poll = async () => {
    try {
      const file = await journal.getFile()
      if (file.size < offset) throw new Error('hardware_trigger_journal_truncated')
      const bytes = new Uint8Array(await file.slice(offset, offset + JOURNAL_READ_BYTES).arrayBuffer())
      const lastLine = bytes.lastIndexOf(10)
      if (lastLine < 0) return
      offset += lastLine + 1
      for (const event of journalEvents(decoder.decode(bytes.subarray(0, lastLine + 1)), sessionId)) {
        if (![...pending].some(marker => marker.code === event.code && marker.sentAt <= event.hostTime)) continue
        const events = rows.get(event.code) ?? []
        events.push(event)
        rows.set(event.code, events)
      }

      for (const [code, events] of rows) {
        const markers = [...pending].filter(marker => marker.code === code)
        if (events.length > markers.length) throw new Error('ambiguous_hardware_trigger_ack')
        for (const [index, marker] of markers.entries()) {
          const event = events[0]
          if (!event) break
          if (event.hostTime < marker.sentAt) throw new Error('ambiguous_hardware_trigger_ack')
          // A trailing event can match either send when both carry the same code.
          // Wait for both events unless this one precedes the next send.
          const next = markers[index + 1]
          if (next && events.length < markers.length - index && event.hostTime >= next.sentAt) break
          events.shift()
          marker.resolve({ ...event.row, label: undefined, accepted: true })
        }
        if (!events.length) rows.delete(code)
      }
    } catch (error) {
      // A snapshot can become unreadable if the recorder appends while it is read.
      if (!(error instanceof DOMException && error.name === 'NotReadableError')) fail(error)
    } finally {
      polling = false
      if (pending.size) schedulePoll()
    }
  }

  const schedulePoll = () => {
    if (polling) return
    polling = true
    setTimeout(() => { void poll() }, JOURNAL_POLL_MS)
  }

  return {
    send(code, signal) {
      signal.throwIfAborted()
      if (failure) throw failure
      const frame = stm32TriggerFrame(code)
      const writer = writable.getWriter()
      const sentAt = Date.now()
      let written: Promise<void>
      try { written = writer.write(frame) }
      finally { writer.releaseLock() }
      return new Promise((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener('abort', abort)
          pending.delete(marker)
        }
        const abort = () => fail(signal.reason ?? new Error('hardware_trigger_ack_timeout'))
        const marker: PendingMarker = {
          code, sentAt,
          resolve: event => { finish(); resolve(event) },
          reject: error => { finish(); reject(error) },
        }
        pending.add(marker)
        signal.addEventListener('abort', abort, { once: true })
        void written.catch(fail)
        schedulePoll()
      })
    },
  }
}

export const openHardwareTrigger: OpenHardwareTrigger = async ({ sessionId, signal }) => {
  if (typeof navigator === 'undefined' || !navigator.serial) {
    return { reason: 'serial_unsupported', message: '浏览器未提供 Web Serial，请在 Edge 或 Chrome 的本机实验页打开。' }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return { reason: 'invalid_trigger_request', message: '当前 GUI 会话号或事件码无效。' }
  }
  const filename = `${sessionId}_events.jsonl`
  let failure: HardwareTriggerFailure = { reason: 'directory_unavailable', message: '无法读取 GUI 录制目录授权。' }
  try {
    const folder = await getDirectory()
    if (!folder) return { reason: 'directory_not_selected', message: '请在「CH340 硬件打标」里选择 GUI 录制目录。' }
    if (await folder.queryPermission({ mode: 'read' }) !== 'granted') {
      return { reason: 'directory_permission_missing', message: `请重新授权 GUI 录制目录「${folder.name}」。` }
    }
    failure = { reason: 'journal_unreadable', message: `无法读取「${folder.name}」里的 ${filename}。` }
    const journal = await folder.getFileHandle(filename).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        failure = { reason: 'journal_not_found', message: `「${folder.name}」里没有 ${filename}，请选择 OmniBCI 正在写入的目录。` }
      }
      throw error
    })
    failure = { reason: 'serial_enumeration_failed', message: '无法读取浏览器已授权的串口。' }
    const ports = (await navigator.serial.getPorts()).filter(isCh340)
    const port = selectedPort && ports.includes(selectedPort) ? selectedPort : ports.length === 1 ? ports[0] : undefined
    if (!port) return ports.length > 1
      ? { reason: 'serial_port_ambiguous', message: '有多个 CH340，请重新选择本次使用的打标板。' }
      : { reason: 'serial_port_missing', message: '浏览器找不到已授权的 CH340，请检查连接并选择打标板。' }
    signal.throwIfAborted()
    failure = { reason: 'serial_port_open_failed', message: '无法以 10000 波特率打开 CH340 串口。' }
    if (!port.writable) await port.open({ baudRate: STM32_TRIGGER_BAUD })
    const writable = port.writable
    if (!writable || writable.locked) {
      return { reason: 'serial_port_busy', message: 'CH340 串口当前不可写或正在被占用。' }
    }
    signal.throwIfAborted()
    failure = { reason: 'journal_unreadable', message: `无法读取「${folder.name}」里的 ${filename}。` }
    const before = await journal.getFile()
    signal.throwIfAborted()
    return createHardwareLink(writable, journal, before.size, sessionId)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && failure.reason !== 'journal_not_found') {
      return { ...failure, message: `${failure.message} ${error.message}` }
    }
    return failure
  }
}

export const prepareHardwareTrigger: PrepareHardwareTrigger = async ({ code, sessionId, signal }) => {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    return { reason: 'invalid_trigger_request', message: '当前 GUI 会话号或事件码无效。' }
  }
  const link = await openHardwareTrigger({ sessionId, signal })
  return 'send' in link ? { send: () => link.send(code, signal) } : link
}
