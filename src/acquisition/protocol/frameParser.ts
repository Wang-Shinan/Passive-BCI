import {
  CHANNELS,
  FRAME_BYTES,
  SYNC1,
  SYNC2,
  type DecodedFrame,
} from './constants'
import { crc16Ccitt } from './crc16'

export class AdsFrameParser {
  private buf = new Uint8Array(0)
  private getLsbUv: () => Float32Array
  crcBad = 0
  syncDrop = 0

  constructor(getLsbUv: () => Float32Array) {
    this.getLsbUv = getLsbUv
  }

  reset(): void {
    this.buf = new Uint8Array(0)
    this.crcBad = 0
    this.syncDrop = 0
  }

  feed(chunk: Uint8Array): DecodedFrame[] {
    if (chunk.byteLength) {
      const next = new Uint8Array(this.buf.length + chunk.byteLength)
      next.set(this.buf)
      next.set(chunk, this.buf.length)
      this.buf = next
    }

    const out: DecodedFrame[] = []
    while (this.buf.length >= 2) {
      const idx = findSync(this.buf)
      if (idx < 0) {
        if (this.buf.length > 1) {
          this.syncDrop += this.buf.length - 1
          this.buf = this.buf.subarray(this.buf.length - 1)
        }
        return out
      }
      if (idx > 0) {
        this.syncDrop += idx
        this.buf = this.buf.subarray(idx)
      }
      if (this.buf.length < FRAME_BYTES) return out

      const frame = this.buf.subarray(0, FRAME_BYTES)
      if (frame[2] !== 1 || frame[3] !== 1) {
        this.buf = this.buf.subarray(1)
        this.syncDrop += 1
        continue
      }

      const rxCrc = frame[46]! | (frame[47]! << 8)
      const calc = crc16Ccitt(frame, 0, 46)
      if (rxCrc !== calc) {
        this.crcBad += 1
        this.buf = this.buf.subarray(1)
        continue
      }

      const copy = new Uint8Array(FRAME_BYTES)
      copy.set(frame)
      this.buf = this.buf.subarray(FRAME_BYTES)
      out.push(this.decode(copy))
    }

    if (this.buf.length > 500_000) {
      this.buf = this.buf.subarray(this.buf.length - 1000)
    }
    return out
  }

  private decode(frame: Uint8Array): DecodedFrame {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const sequence = view.getUint32(4, true)
    const flags = frame[15]!
    const valid = Boolean(flags & 0x01) && Boolean(flags & 0x02)
    const rawCounts = new Int32Array(CHANNELS)
    const lsb = this.getLsbUv()
    const uv = new Float32Array(CHANNELS)
    for (let ch = 0; ch < CHANNELS; ch++) {
      const i = 16 + ch * 3
      let v = (frame[i]! << 16) | (frame[i + 1]! << 8) | frame[i + 2]!
      if (v & 0x800000) v -= 0x1000000
      rawCounts[ch] = v
      uv[ch] = v * (lsb[ch] ?? lsb[0] ?? 1)
    }
    return {
      sequence,
      uv,
      valid,
      mode: frame[43]!,
      flags,
      readUs: view.getUint16(40, true),
      pending: frame[42]!,
      queueDepth: frame[44]!,
      queueDropLow: frame[45]!,
      rawCounts,
      raw: frame,
    }
  }
}

function findSync(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === SYNC1 && buf[i + 1] === SYNC2) return i
  }
  return -1
}
