/** 12-byte ADS1299 config ACK emitted by Omni firmware (`0xBC` + command). */

export const CONFIG_ACK_BYTES = 12
export const CONFIG_ACK_MARKER = 0xbc

export type ConfigAck = {
  command: number
  argument: number
  channelRegister: number
  biasP: number
  biasN: number
  misc1: number
  loffP: number
  loffN: number
  loffConfig: number
  reference: number
  mode: number
  verified: boolean
  enabledMask: number
}

export function xorChecksum(bytes: Uint8Array, start: number, n: number): number {
  let x = 0
  for (let i = 0; i < n; i++) x ^= bytes[start + i]!
  return x & 0xff
}

export function parseConfigAck(packet: Uint8Array): ConfigAck | null {
  if (packet.length < CONFIG_ACK_BYTES) return null
  if (packet[0] !== CONFIG_ACK_MARKER) return null
  if (xorChecksum(packet, 0, 11) !== packet[11]) return null
  return {
    command: packet[1]!,
    argument: packet[2]!,
    channelRegister: packet[3]!,
    biasP: packet[4]!,
    biasN: packet[5]!,
    misc1: packet[6]!,
    loffP: packet[4]!,
    loffN: packet[5]!,
    loffConfig: packet[6]!,
    reference: packet[7]!,
    mode: packet[8]!,
    verified: Boolean(packet[9]! & 0x01),
    enabledMask: packet[10]!,
  }
}

/**
 * Pull the first valid ACK for `expectedCmd` out of a growing serial buffer.
 * Invalid checksum at the marker advances two bytes (Omni GUI behaviour).
 */
export function extractConfigAck(
  buffer: Uint8Array,
  expectedCmd: number,
): { ack: ConfigAck; rest: Uint8Array } | null {
  const marker = CONFIG_ACK_MARKER
  const cmd = expectedCmd & 0xff
  let start = 0
  while (start + CONFIG_ACK_BYTES <= buffer.length) {
    let found = -1
    for (let i = start; i + 1 < buffer.length; i++) {
      if (buffer[i] === marker && buffer[i + 1] === cmd) {
        found = i
        break
      }
    }
    if (found < 0) return null
    if (found + CONFIG_ACK_BYTES > buffer.length) return null
    const packet = buffer.subarray(found, found + CONFIG_ACK_BYTES)
    const ack = parseConfigAck(packet)
    if (!ack) {
      start = found + 2
      continue
    }
    return { ack, rest: buffer.subarray(found + CONFIG_ACK_BYTES) }
  }
  return null
}

export class ConfigAckScanner {
  private buf = new Uint8Array(0)
  expectedCmd: number | null = null

  begin(cmd: number): void {
    this.expectedCmd = cmd & 0xff
    this.buf = new Uint8Array(0)
  }

  clear(): Uint8Array {
    const leftover = this.buf
    this.expectedCmd = null
    this.buf = new Uint8Array(0)
    return leftover
  }

  /** While waiting, EEG bytes are held. After ACK, leftover (if any) is returned. */
  feed(chunk: Uint8Array): { leftover: Uint8Array; ack: ConfigAck | null } {
    if (this.expectedCmd == null) return { leftover: chunk, ack: null }
    if (!chunk.byteLength && !this.buf.byteLength) return { leftover: chunk, ack: null }
    const next = new Uint8Array(this.buf.length + chunk.byteLength)
    next.set(this.buf)
    if (chunk.byteLength) next.set(chunk, this.buf.length)
    this.buf = next
    const hit = extractConfigAck(this.buf, this.expectedCmd)
    if (hit) {
      this.expectedCmd = null
      this.buf = new Uint8Array(0)
      return { leftover: hit.rest, ack: hit.ack }
    }
    if (this.buf.length > 256) this.buf = this.buf.subarray(this.buf.length - 32)
    return { leftover: new Uint8Array(0), ack: null }
  }
}
