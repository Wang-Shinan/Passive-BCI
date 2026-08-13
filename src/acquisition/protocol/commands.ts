import {
  CHANNELS,
  REFERENCE_SRB2,
  type ChannelConfig,
  type ReferenceMode,
} from './constants'

/** Stop streaming. */
export const CMD_STOP = new Uint8Array([0x73]) // 's'

/** Begin binary streaming. */
export const CMD_START = new Uint8Array([0x62]) // 'b'

/** BLE reliable session reset (USB ignores). */
export const CMD_RELIABLE_RESET = new Uint8Array([0x72]) // 'r'

export function cmdMode(byte: number): Uint8Array {
  return new Uint8Array([byte & 0xff])
}

export function cmdReference(mode: ReferenceMode): Uint8Array {
  return new Uint8Array([0xa8, mode & 0x01])
}

/** Atomic eight-channel init: A5 REF ENABLED BIAS SRB2 G1..G8 */
export function cmdBulkConfig(cfg: ChannelConfig): Uint8Array {
  let enabled = 0
  let bias = 0
  let srb2 = 0
  for (let ch = 0; ch < CHANNELS; ch++) {
    if (cfg.enabled[ch]) enabled |= 1 << ch
    if (cfg.enabled[ch] && cfg.bias[ch]) bias |= 1 << ch
    if (cfg.reference === REFERENCE_SRB2 && cfg.enabled[ch] && cfg.srb2[ch]) {
      srb2 |= 1 << ch
    }
  }
  const out = new Uint8Array(5 + CHANNELS)
  out[0] = 0xa5
  out[1] = cfg.reference & 0x01
  out[2] = enabled & 0xff
  out[3] = bias & 0xff
  out[4] = srb2 & 0xff
  for (let ch = 0; ch < CHANNELS; ch++) out[5 + ch] = (cfg.gains[ch] ?? 24) & 0xff
  return out
}

/** Legacy per-channel: A7 CH GAIN FLAGS */
export function cmdChannelConfig(
  ch: number,
  gain: number,
  enabled: boolean,
  bias: boolean,
  srb2: boolean,
  reference: ReferenceMode,
): Uint8Array {
  const flags =
    (enabled ? 0x01 : 0) |
    (enabled && bias ? 0x02 : 0) |
    (reference === REFERENCE_SRB2 && enabled && srb2 ? 0x04 : 0)
  return new Uint8Array([0xa7, ch & 0x07, gain & 0xff, flags])
}

/** BIAS_SENSP mask: A6 0D XX */
export function cmdBiasMask(mask: number): Uint8Array {
  return new Uint8Array([0xa6, 0x0d, mask & 0xff])
}

/** AC lead-off enable mask: A9 XX (must be sent while streaming is stopped). */
export function cmdLeadOff(mask: number): Uint8Array {
  return new Uint8Array([0xa9, mask & 0xff])
}
