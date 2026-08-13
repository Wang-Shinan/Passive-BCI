/** Standard 10–20 (and common extras) unit-disk positions for topography. */

export type Xy = { x: number; y: number }

/** Nose at +y, right ear at +x. Coordinates in [-1,1]. */
const TABLE: Record<string, Xy> = {
  FP1: { x: -0.28, y: 0.9 },
  FP2: { x: 0.28, y: 0.9 },
  FPZ: { x: 0, y: 0.95 },
  FPZ_: { x: 0, y: 0.95 },
  AF3: { x: -0.35, y: 0.72 },
  AF4: { x: 0.35, y: 0.72 },
  AF7: { x: -0.55, y: 0.7 },
  AF8: { x: 0.55, y: 0.7 },
  F7: { x: -0.72, y: 0.55 },
  F3: { x: -0.4, y: 0.5 },
  FZ: { x: 0, y: 0.5 },
  F4: { x: 0.4, y: 0.5 },
  F8: { x: 0.72, y: 0.55 },
  F1: { x: -0.2, y: 0.5 },
  F2: { x: 0.2, y: 0.5 },
  F5: { x: -0.55, y: 0.5 },
  F6: { x: 0.55, y: 0.5 },
  FT7: { x: -0.82, y: 0.3 },
  FT8: { x: 0.82, y: 0.3 },
  FT9: { x: -0.9, y: 0.25 },
  FT10: { x: 0.9, y: 0.25 },
  FC5: { x: -0.55, y: 0.28 },
  FC3: { x: -0.35, y: 0.28 },
  FC1: { x: -0.18, y: 0.28 },
  FCZ: { x: 0, y: 0.28 },
  FC2: { x: 0.18, y: 0.28 },
  FC4: { x: 0.35, y: 0.28 },
  FC6: { x: 0.55, y: 0.28 },
  T7: { x: -0.9, y: 0 },
  T3: { x: -0.9, y: 0 },
  C5: { x: -0.55, y: 0 },
  C3: { x: -0.4, y: 0 },
  C1: { x: -0.2, y: 0 },
  CZ: { x: 0, y: 0 },
  C2: { x: 0.2, y: 0 },
  C4: { x: 0.4, y: 0 },
  C6: { x: 0.55, y: 0 },
  T8: { x: 0.9, y: 0 },
  T4: { x: 0.9, y: 0 },
  TP7: { x: -0.82, y: -0.3 },
  TP8: { x: 0.82, y: -0.3 },
  TP9: { x: -0.9, y: -0.25 },
  TP10: { x: 0.9, y: -0.25 },
  CP5: { x: -0.55, y: -0.28 },
  CP3: { x: -0.35, y: -0.28 },
  CP1: { x: -0.18, y: -0.28 },
  CPZ: { x: 0, y: -0.28 },
  CP2: { x: 0.18, y: -0.28 },
  CP4: { x: 0.35, y: -0.28 },
  CP6: { x: 0.55, y: -0.28 },
  P7: { x: -0.72, y: -0.55 },
  P3: { x: -0.4, y: -0.5 },
  PZ: { x: 0, y: -0.5 },
  P4: { x: 0.4, y: -0.5 },
  P8: { x: 0.72, y: -0.55 },
  P5: { x: -0.55, y: -0.5 },
  P6: { x: 0.55, y: -0.5 },
  PO3: { x: -0.3, y: -0.72 },
  PO4: { x: 0.3, y: -0.72 },
  PO5: { x: -0.45, y: -0.72 },
  PO6: { x: 0.45, y: -0.72 },
  PO7: { x: -0.55, y: -0.7 },
  PO8: { x: 0.55, y: -0.7 },
  POZ: { x: 0, y: -0.72 },
  O1: { x: -0.28, y: -0.9 },
  OZ: { x: 0, y: -0.95 },
  O2: { x: 0.28, y: -0.9 },
  IO: { x: 0, y: -1.05 },
}

export function normalizeElectrodeName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase().replace('Z', 'Z')
}

export function electrodeXy(name: string): Xy | null {
  const key = normalizeElectrodeName(name)
  if (TABLE[key]) return TABLE[key]!
  // Fp1 vs FP1
  const alt = key.replace(/^FP/, 'FP')
  return TABLE[alt] ?? null
}

export function colorForValue(t: number): string {
  // t in [0,1] → blue→cyan→yellow→red
  const x = Math.max(0, Math.min(1, t))
  const r = Math.round(40 + 200 * Math.max(0, x - 0.35) / 0.65)
  const g = Math.round(x < 0.5 ? 80 + 160 * (x / 0.5) : 240 - 160 * ((x - 0.5) / 0.5))
  const b = Math.round(x < 0.45 ? 220 - 100 * (x / 0.45) : Math.max(40, 120 - 200 * ((x - 0.45) / 0.55)))
  return `rgb(${r},${g},${b})`
}
