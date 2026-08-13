/** OmniBCI ADS1299 USB/BLE shared wire protocol (48-byte frames). */

export const FS = 250
export const CHANNELS = 8
export const BAUD = 921600
export const FRAME_BYTES = 48
export const SYNC1 = 0xa5
export const SYNC2 = 0x5a
export const VREF = 4.5
export const ADC_SATURATION_FRACTION = 0.95
/** ADS1299 AC lead-off (Omni firmware LOFF_AC_6NA_31HZ). */
export const LEAD_OFF_FREQUENCY_HZ = FS / 8
export const LEAD_OFF_CURRENT_NA = 6
export const LEAD_OFF_SERIES_SRB1_KOHM = 9.98
export const LEAD_OFF_SERIES_SRB2_KOHM = 4.4
export const IMPEDANCE_GOOD_KOHM = 10
export const IMPEDANCE_OK_KOHM = 50
export const LOFF_CONFIG_AC_6NA = 0x02

export const CHANNEL_NAMES = [
  'CH1',
  'CH2',
  'CH3',
  'CH4',
  'CH5',
  'CH6',
  'CH7',
  'CH8',
] as const

export const VALID_GAINS = [1, 2, 4, 6, 8, 12, 24] as const

export const REFERENCE_SRB1 = 0
export const REFERENCE_SRB2 = 1

export type ReferenceMode = typeof REFERENCE_SRB1 | typeof REFERENCE_SRB2

export const MODE_ITEMS = [
  { label: 'EEG + BIAS P+N', cmd: 0x6e /* n */, mode: 0 },
  { label: 'EEG + BIAS 仅信号侧', cmd: 0x70 /* p */, mode: 1 },
  { label: 'EEG + BIAS off', cmd: 0x6f /* o */, mode: 2 },
  { label: 'ADS internal short', cmd: 0x71 /* q */, mode: 3 },
  { label: 'ADS internal test square', cmd: 0x74 /* t */, mode: 4 },
] as const

export const MODE_NAMES: Record<number, string> = {
  0: 'EEG/BIAS P+N',
  1: 'EEG/BIAS signal-side',
  2: 'EEG/BIAS-off',
  3: 'SHORTED',
  4: 'TEST',
}

export interface DecodedFrame {
  sequence: number
  uv: Float32Array
  valid: boolean
  mode: number
  flags: number
  readUs: number
  pending: number
  queueDepth: number
  queueDropLow: number
  rawCounts: Int32Array
  raw: Uint8Array
}

export interface ChannelConfig {
  enabled: boolean[]
  bias: boolean[]
  srb2: boolean[]
  gains: number[]
  /** Display / montage labels (not sent to firmware). */
  labels: string[]
  reference: ReferenceMode
}

export function defaultChannelConfig(): ChannelConfig {
  return {
    enabled: Array.from({ length: CHANNELS }, () => true),
    bias: Array.from({ length: CHANNELS }, (_, i) => i < 5),
    srb2: Array.from({ length: CHANNELS }, () => true),
    gains: Array.from({ length: CHANNELS }, () => 24),
    labels: [...CHANNEL_NAMES],
    reference: REFERENCE_SRB1,
  }
}

/** Common 8-channel montage presets (labels only). */
export const MONTAGE_PRESETS: { id: string; label: string; names: string[] }[] = [
  {
    id: 'ch',
    label: '默认 CH1–CH8',
    names: [...CHANNEL_NAMES],
  },
  {
    id: 'frontal',
    label: '额区 8 导',
    names: ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'Cz'],
  },
  {
    id: 'central',
    label: '中央 / 顶',
    names: ['F3', 'F4', 'C3', 'Cz', 'C4', 'P3', 'Pz', 'P4'],
  },
  {
    id: 'motor',
    label: '运动区',
    names: ['FC3', 'FCz', 'FC4', 'C3', 'Cz', 'C4', 'CP3', 'CP4'],
  },
  {
    id: 'temporal',
    label: '颞区侧重',
    names: ['F7', 'T7', 'P7', 'O1', 'F8', 'T8', 'P8', 'O2'],
  },
]

/** 博睿康 64 导设备常用 59 路头皮 EEG（来自 oi-mi，排除 ECG/EOG）。 */
export const NEURACLE_59_MONTAGE = [
  'Fpz', 'Fp1', 'Fp2', 'AF3', 'AF4', 'AF7', 'AF8', 'Fz',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'FCz',
  'FC1', 'FC2', 'FC3', 'FC4', 'FC5', 'FC6', 'FT7', 'FT8',
  'Cz', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'T7', 'T8',
  'CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'CP6', 'TP7', 'TP8',
  'Pz', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'POz', 'PO3',
  'PO4', 'PO5', 'PO6', 'PO7', 'PO8', 'Oz', 'O1', 'O2',
] as const

/** Default plot subset when Neuracle streams 59 channels. */
export const NEURACLE_DEFAULT_VISIBLE = [
  'F3', 'F4', 'C3', 'Cz', 'C4', 'P3', 'Pz', 'P4',
] as const

/** Input-referred LSB in μV for one PGA gain. */
export function calcLsbUv(gain: number): number {
  return (VREF / (gain * (2 ** 23 - 1))) * 1e6
}

export function channelLsbUv(gains: number[]): Float32Array {
  const out = new Float32Array(CHANNELS)
  for (let i = 0; i < CHANNELS; i++) out[i] = calcLsbUv(gains[i] ?? 24)
  return out
}
