/** CRC-16/CCITT (poly 0x1021, init 0xFFFF) — same as Python binascii.crc_hqx. */

export function crc16Ccitt(data: Uint8Array, offset = 0, length = data.length): number {
  let crc = 0xffff
  const end = offset + length
  for (let i = offset; i < end; i++) {
    crc ^= (data[i]! & 0xff) << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}
