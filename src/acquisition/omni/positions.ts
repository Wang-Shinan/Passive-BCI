import type { ChannelConfig } from '../protocol/constants.js'

/** Coordinates use metres in the REVE position-bank frame. No recentering. */
export function sphericalToCartesian(azimuth: number, elevation: number, radius: number): number[] {
  const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180
  return [radius * Math.cos(e) * Math.cos(a), radius * Math.cos(e) * Math.sin(a), radius * Math.sin(e)]
}

/** Empty array means an explicitly selected but incomplete/invalid coordinate layout. */
export function omniElectrodePositions(config: Pick<ChannelConfig, 'positionMode' | 'positionCoordinates'>): number[][] | undefined {
  if (!config.positionMode || config.positionMode === 'standard') return undefined
  const rows = config.positionCoordinates
  if (!rows || rows.length !== 8) return []
  const points: number[][] = []
  for (const row of rows) {
    if (row.length !== 3 || row.some(v => !v.trim() || !Number.isFinite(Number(v)))) return []
    const values = row.map(Number)
    if (config.positionMode === 'spherical') {
      if (values[1]! < -90 || values[1]! > 90 || values[2]! <= 0) return []
      points.push(sphericalToCartesian(values[0]!, values[1]!, values[2]!))
    } else points.push(values)
  }
  return points
}

export function validElectrodePositions(value: unknown, channels = 8): value is number[][] {
  return Array.isArray(value) && value.length === channels && value.every(row =>
    Array.isArray(row) && row.length === 3 && row.every(n => typeof n === 'number' && Number.isFinite(n))) &&
    new Set(value.map(row => JSON.stringify(row))).size === channels
}
