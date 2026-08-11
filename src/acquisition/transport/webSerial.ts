import { BAUD } from '../protocol/constants'

export type SerialStatus = 'idle' | 'connecting' | 'open' | 'error' | 'unsupported'

export interface WebSerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

declare global {
  interface SerialPort {
    readonly readable: ReadableStream<Uint8Array> | null
    readonly writable: WritableStream<Uint8Array> | null
    open(options: { baudRate: number; bufferSize?: number }): Promise<void>
    close(): Promise<void>
    getInfo(): WebSerialPortInfo
  }

  interface Serial {
    requestPort(options?: {
      filters?: Array<{ usbVendorId?: number; usbProductId?: number }>
    }): Promise<SerialPort>
    getPorts(): Promise<SerialPort[]>
  }

  interface Navigator {
    serial?: Serial
  }
}

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serial)
}

export class WebSerialTransport {
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private readLoopActive = false
  private onData: ((chunk: Uint8Array) => void) | null = null
  private onStatus: ((s: SerialStatus, detail?: string) => void) | null = null

  setHandlers(opts: {
    onData: (chunk: Uint8Array) => void
    onStatus: (s: SerialStatus, detail?: string) => void
  }): void {
    this.onData = opts.onData
    this.onStatus = opts.onStatus
  }

  get connected(): boolean {
    return this.port !== null
  }

  async requestAndOpen(baudRate = BAUD): Promise<void> {
    if (!webSerialSupported()) {
      this.onStatus?.('unsupported', '当前浏览器不支持 Web Serial（请用 Chrome / Edge，且需 HTTPS 或 localhost）')
      throw new Error('Web Serial unsupported')
    }
    this.onStatus?.('connecting')
    const port = await navigator.serial!.requestPort()
    await this.openPort(port, baudRate)
  }

  async openExisting(baudRate = BAUD): Promise<boolean> {
    if (!webSerialSupported()) return false
    const ports = await navigator.serial!.getPorts()
    if (!ports.length) return false
    this.onStatus?.('connecting')
    await this.openPort(ports[0]!, baudRate)
    return true
  }

  private async openPort(port: SerialPort, baudRate: number): Promise<void> {
    await this.close()
    this.port = port
    await port.open({ baudRate, bufferSize: 1024 * 1024 })
    if (!port.readable || !port.writable) {
      await this.close()
      throw new Error('串口缺少 readable/writable')
    }
    this.writer = port.writable.getWriter()
    this.reader = port.readable.getReader()
    this.readLoopActive = true
    void this.readLoop()
    const info = port.getInfo()
    const tag =
      info.usbVendorId != null
        ? `VID ${info.usbVendorId.toString(16)} PID ${(info.usbProductId ?? 0).toString(16)}`
        : 'serial'
    this.onStatus?.('open', `已打开 ${tag} @ ${baudRate}`)
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('串口未打开')
    await this.writer.write(data)
  }

  async close(): Promise<void> {
    this.readLoopActive = false
    try {
      await this.reader?.cancel()
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock()
    } catch {
      /* ignore */
    }
    this.reader = null
    try {
      await this.writer?.close()
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock()
    } catch {
      /* ignore */
    }
    this.writer = null
    try {
      await this.port?.close()
    } catch {
      /* ignore */
    }
    this.port = null
    this.onStatus?.('idle')
  }

  private async readLoop(): Promise<void> {
    const reader = this.reader
    if (!reader) return
    try {
      while (this.readLoopActive) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.byteLength) this.onData?.(value)
      }
    } catch (err) {
      if (this.readLoopActive) {
        const msg = err instanceof Error ? err.message : String(err)
        this.onStatus?.('error', `串口读取中断：${msg}`)
      }
    } finally {
      if (this.readLoopActive) {
        this.readLoopActive = false
        await this.close()
      }
    }
  }
}
