/** In-browser raw BIN recorder (48-byte frames), downloadable as one file. */

export class BinRecorder {
  private chunks: Uint8Array[] = []
  private bytes = 0
  private startedAt: number | null = null
  private sessionId = ''

  get recording(): boolean {
    return this.startedAt !== null
  }

  get byteLength(): number {
    return this.bytes
  }

  get id(): string {
    return this.sessionId
  }

  start(sessionId?: string): void {
    this.chunks = []
    this.bytes = 0
    this.startedAt = Date.now()
    this.sessionId = sessionId ?? makeSessionId()
  }

  append(frameRaw: Uint8Array): void {
    if (this.startedAt === null) return
    const copy = new Uint8Array(frameRaw.byteLength)
    copy.set(frameRaw)
    this.chunks.push(copy)
    this.bytes += copy.byteLength
  }

  stopAndDownload(filenamePrefix = 'omni_ads1299'): { bytes: number; name: string } | null {
    if (this.startedAt === null || this.bytes === 0) {
      this.startedAt = null
      this.chunks = []
      return null
    }
    const blob = new Blob(this.chunks as BlobPart[], { type: 'application/octet-stream' })
    const name = `${filenamePrefix}_${this.sessionId}.bin`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
    const bytes = this.bytes
    this.startedAt = null
    this.chunks = []
    this.bytes = 0
    return { bytes, name }
  }

  discard(): void {
    this.startedAt = null
    this.chunks = []
    this.bytes = 0
  }
}

function makeSessionId(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
