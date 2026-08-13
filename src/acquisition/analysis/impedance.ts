/**
 * Omni ADS1299 AC lead-off: 6 nA @ Fs/8 (31.25 Hz @ 250 SPS).
 * Z_kΩ = max(0, Vpeak_µV / I_nA − series_kΩ)
 */

import {
  FS,
  LEAD_OFF_CURRENT_NA,
  LEAD_OFF_FREQUENCY_HZ,
  LEAD_OFF_SERIES_SRB1_KOHM,
  LEAD_OFF_SERIES_SRB2_KOHM,
  IMPEDANCE_GOOD_KOHM,
  IMPEDANCE_OK_KOHM,
  LOFF_CONFIG_AC_6NA,
  REFERENCE_SRB2,
  type ReferenceMode,
} from '../protocol/constants'
import type { ConfigAck } from '../protocol/configAck'

export type ImpedanceQuality = 'good' | 'ok' | 'poor' | 'none'

export type ImpedanceEstimate = {
  kohm: number | null
  peakUv: number
  nGood: number
  label: string
  quality: ImpedanceQuality
  color: string
}

export function impedanceQuality(kohm: number | null): {
  quality: ImpedanceQuality
  text: string
  color: string
} {
  if (kohm == null || !Number.isFinite(kohm)) {
    return { quality: 'none', text: '—', color: '' }
  }
  if (kohm < IMPEDANCE_GOOD_KOHM) return { quality: 'good', text: '良好', color: '#258b3b' }
  if (kohm <= IMPEDANCE_OK_KOHM) return { quality: 'ok', text: '可用', color: '#d97800' }
  return { quality: 'poor', text: '接触不良', color: '#c62828' }
}

export function formatImpedanceKohm(kohm: number | null): string {
  if (kohm == null || !Number.isFinite(kohm)) return '—'
  if (kohm > 999) return '>999 kΩ'
  return `${kohm.toFixed(1)} kΩ`
}

export type ImpedanceRowState = {
  selected: boolean
  enabled: boolean
  kohm: number | null
  text: string
  quality: ImpedanceQuality
  color: string
}

export function rowFromKohm(
  kohm: number | null,
  selected: boolean,
  enabled: boolean,
  idleText = '等待检测',
): ImpedanceRowState {
  if (!enabled) {
    return { selected: false, enabled, kohm: null, text: '未启用', quality: 'none', color: '' }
  }
  if (!selected) {
    return { selected, enabled, kohm: null, text: '未选择', quality: 'none', color: '' }
  }
  if (kohm == null || !Number.isFinite(kohm)) {
    return { selected, enabled, kohm: null, text: idleText, quality: 'none', color: '' }
  }
  const q = impedanceQuality(kohm)
  return {
    selected,
    enabled,
    kohm,
    text: formatImpedanceKohm(kohm),
    quality: q.quality,
    color: q.color,
  }
}

/** 3×3 Gaussian solve (no pivoting beyond abs max on diagonal). */
function solve3(A: number[], b: number[]): [number, number, number] | null {
  const m = A.slice()
  const y = b.slice()
  for (let col = 0; col < 3; col++) {
    let pivot = col
    let best = Math.abs(m[col * 3 + col]!)
    for (let r = col + 1; r < 3; r++) {
      const v = Math.abs(m[r * 3 + col]!)
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (best < 1e-18) return null
    if (pivot !== col) {
      for (let c = 0; c < 3; c++) {
        const tmp = m[col * 3 + c]!
        m[col * 3 + c] = m[pivot * 3 + c]!
        m[pivot * 3 + c] = tmp
      }
      const ty = y[col]!
      y[col] = y[pivot]!
      y[pivot] = ty
    }
    const diag = m[col * 3 + col]!
    for (let r = col + 1; r < 3; r++) {
      const f = m[r * 3 + col]! / diag
      for (let c = col; c < 3; c++) m[r * 3 + c] -= f * m[col * 3 + c]!
      y[r] -= f * y[col]!
    }
  }
  const x = [0, 0, 0]
  for (let i = 2; i >= 0; i--) {
    let s = y[i]!
    for (let c = i + 1; c < 3; c++) s -= m[i * 3 + c]! * x[c]!
    x[i] = s / m[i * 3 + i]!
  }
  return [x[0]!, x[1]!, x[2]!]
}

/**
 * Least-squares fit of `a sin(2πft) + b cos(2πft) + c` on good samples.
 * Peak amplitude is hypot(a, b). Same as Omni `np.linalg.lstsq`.
 */
export function fitLeadOffPeakUv(
  samples: ArrayLike<number>,
  valid: ArrayLike<boolean | number> | null,
  fs: number,
  freqHz = LEAD_OFF_FREQUENCY_HZ,
): { peakUv: number; nGood: number } | null {
  const n = samples.length
  const need = Math.max(16, Math.floor(fs))
  const omega = (2 * Math.PI * freqHz) / fs
  let ata00 = 0,
    ata01 = 0,
    ata02 = 0,
    ata11 = 0,
    ata12 = 0,
    ata22 = 0
  let atb0 = 0,
    atb1 = 0,
    atb2 = 0
  let nGood = 0
  for (let i = 0; i < n; i++) {
    const ok = valid ? Boolean(valid[i]) : true
    const y = samples[i]!
    if (!ok || !Number.isFinite(y)) continue
    const s = Math.sin(omega * i)
    const c = Math.cos(omega * i)
    ata00 += s * s
    ata01 += s * c
    ata02 += s
    ata11 += c * c
    ata12 += c
    ata22 += 1
    atb0 += s * y
    atb1 += c * y
    atb2 += y
    nGood += 1
  }
  if (nGood < need) return { peakUv: Number.NaN, nGood }
  const coeff = solve3(
    [ata00, ata01, ata02, ata01, ata11, ata12, ata02, ata12, ata22],
    [atb0, atb1, atb2],
  )
  if (!coeff) return { peakUv: Number.NaN, nGood }
  return { peakUv: Math.hypot(coeff[0], coeff[1]), nGood }
}

export function estimateLeadOffKohm(
  samples: ArrayLike<number>,
  valid: ArrayLike<boolean | number> | null,
  seriesKohm: number,
  fs = FS,
  currentNa = LEAD_OFF_CURRENT_NA,
  freqHz = LEAD_OFF_FREQUENCY_HZ,
): ImpedanceEstimate {
  const fit = fitLeadOffPeakUv(samples, valid, fs, freqHz)
  if (!fit || !Number.isFinite(fit.peakUv) || fit.nGood < fs) {
    return {
      kohm: null,
      peakUv: Number.NaN,
      nGood: fit?.nGood ?? 0,
      label: fit && fit.nGood > 0 ? '数据不足' : '稳定中…',
      quality: 'none',
      color: '',
    }
  }
  const kohm = Math.max(0, fit.peakUv / currentNa - seriesKohm)
  const q = impedanceQuality(kohm)
  return {
    kohm,
    peakUv: fit.peakUv,
    nGood: fit.nGood,
    label: formatImpedanceKohm(kohm),
    quality: q.quality,
    color: q.color,
  }
}

export function copyLatestChannel(
  buf: Float32Array,
  writeHead: number,
  filled: number,
  n: number,
): Float32Array {
  const take = Math.min(filled, n, buf.length)
  const out = new Float32Array(take)
  const bufLen = buf.length
  for (let i = 0; i < take; i++) {
    const idx = (((writeHead - take + i) % bufLen) + bufLen) % bufLen
    out[i] = buf[idx]!
  }
  return out
}

export function impedanceSeriesDefaultKohm(reference: ReferenceMode): number {
  return reference === REFERENCE_SRB2 ? LEAD_OFF_SERIES_SRB2_KOHM : LEAD_OFF_SERIES_SRB1_KOHM
}

export function leadOffAckMatches(ack: ConfigAck | null, mask: number, srb2: boolean): boolean {
  if (!ack || !ack.verified) return false
  const expectedP = srb2 ? 0 : mask
  const expectedN = srb2 ? mask : 0
  return ack.loffP === expectedP && ack.loffN === expectedN && ack.loffConfig === LOFF_CONFIG_AC_6NA
}

export function leadOffOffAckMatches(ack: ConfigAck | null): boolean {
  return Boolean(ack && ack.verified && ack.loffP === 0 && ack.loffN === 0 && ack.loffConfig === 0)
}

export function copyLatestValid(
  buf: Uint8Array,
  writeHead: number,
  filled: number,
  n: number,
): Uint8Array {
  const take = Math.min(filled, n, buf.length)
  const out = new Uint8Array(take)
  const bufLen = buf.length
  for (let i = 0; i < take; i++) {
    const idx = (((writeHead - take + i) % bufLen) + bufLen) % bufLen
    out[i] = buf[idx]!
  }
  return out
}
