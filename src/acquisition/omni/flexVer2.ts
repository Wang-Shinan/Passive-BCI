const STORAGE_KEY = 'passive-bci.omni-flex-ver2'

export type OmniFlexVer2Config = { enabled: boolean; channelNames: string[] }

// Drawing order, with GND (04/E201) and REF (15/E93) omitted.
// MNE 1.12.1, metres in the standard_1005 native frame used by the REVE bank.
// HydroCel 256 is fitted to the standard_1005 head fiducials with uniform scaling,
// then transformed from head coordinates back to the standard_1005 native frame.
export const OMNI_FLEX_VER2_ELECTRODES: readonly {
  number: number
  name: string
  position: readonly [number, number, number]
}[] = [
  { number: 1, name: 'AFF4h', position: [0.036183300, 0.069150900, 0.041254000] },
  { number: 2, name: 'E210', position: [0.085133396, -0.019307765, -0.028130091] },
  { number: 3, name: 'E209', position: [0.074507444, -0.066135837, -0.069203448] },
  { number: 5, name: 'E190', position: [0.077698632, -0.079449019, -0.033110259] },
  { number: 6, name: 'AFp10', position: [0.037712300, 0.072167900, -0.046197000] },
  { number: 7, name: 'AF8', position: [0.055743300, 0.069656800, -0.010755000] },
  { number: 8, name: 'Fp2', position: [0.029872300, 0.084895900, -0.007080000] },
  { number: 9, name: 'Fpz', position: [0.000112300, 0.088247000, -0.001713000] },
  { number: 10, name: 'AFz', position: [0.000231300, 0.080771000, 0.035417000] },
  { number: 11, name: 'Fp1', position: [-0.029436700, 0.083917100, -0.006990000] },
  { number: 12, name: 'AF7', position: [-0.054839700, 0.068572200, -0.010590000] },
  { number: 13, name: 'AFp9', position: [-0.036124700, 0.072380100, -0.045852000] },
  { number: 14, name: 'E94', position: [-0.073593456, -0.079986391, -0.033140827] },
  { number: 16, name: 'E92', position: [-0.070482338, -0.066650824, -0.069232743] },
  { number: 17, name: 'E68', position: [-0.081457274, -0.019899476, -0.028163751] },
  { number: 18, name: 'AFF3h', position: [-0.034315700, 0.068393100, 0.041188000] },
]

export function loadOmniFlexVer2Config(): OmniFlexVer2Config {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved && typeof saved.enabled === 'boolean' && Array.isArray(saved.channelNames) &&
        saved.channelNames.length <= OMNI_FLEX_VER2_ELECTRODES.length &&
        saved.channelNames.every((name: unknown) => typeof name === 'string')) return saved
  } catch { /* Storage may be unavailable. */ }
  return { enabled: false, channelNames: [] }
}

export function saveOmniFlexVer2Config(config: OmniFlexVer2Config): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)) }
  catch { /* The live configuration is still usable. */ }
}

function normalizeChannelName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase()
}

export function defaultOmniFlexVer2SourceNames(sourceNames: readonly string[]): string[] {
  const numbered = sourceNames.every(name => /^CH[1-9]\d*$/.test(normalizeChannelName(name)))
  return OMNI_FLEX_VER2_ELECTRODES.map(({ name }, index) => numbered ? `CH${index + 1}` : name)
}

export function matchOmniFlexVer2Channels(sourceNames: readonly string[], mapping: readonly string[]): number[] | null {
  const source = sourceNames.map(normalizeChannelName)
  const defaults = defaultOmniFlexVer2SourceNames(source)
  const indices = defaults.map((name, index) => {
    const key = normalizeChannelName(mapping[index] ?? '') || normalizeChannelName(name)
    if (key === 'E201' || key === 'E93' || key === 'GND' || key === 'REF') return -1
    const column = source.indexOf(key)
    return column >= 0 && column === source.lastIndexOf(key) ? column : -1
  })
  return indices.includes(-1) || new Set(indices).size !== indices.length ? null : indices
}
