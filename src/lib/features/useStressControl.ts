import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEMO_ENVELOPE_DRIVER,
  DEFAULT_STRESS_DRIVER,
  adaptProfileForDriver,
  applyRangeMap,
  defaultRangeForDriver,
  displayValueForDriver,
  ema,
  ensureIdsForDriver,
  loadRangeMap,
  loadSignalMode,
  loadStressDriver,
  resolveDriverRaw,
  roundRangeEdge,
  saveRangeMap,
  saveSignalMode,
  saveStressDriver,
  type FeatureRangeMap,
  type SignalControlMode,
} from './controlMapping'
import { useFeatureMonitor } from './useFeatureMonitor'
import { autonomousModulators, type FeatureModulators } from './synthEeg'

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v))
}

const DISPLAY_HIST = 80

/**
 * Stress (0–100) for games: manual slider OR demo/live feature-driven.
 */
export function useStressControl(opts?: {
  initial?: number
  manualModulators?: (stress: number) => FeatureModulators
}) {
  const initial = opts?.initial ?? 40
  const [mode, setModeState] = useState<SignalControlMode>(() => loadSignalMode())
  const [driverFeature, setDriverFeatureState] = useState(() => {
    const d = loadStressDriver()
    if (d === 'cognitive_load') {
      saveStressDriver(DEFAULT_STRESS_DRIVER)
      return DEFAULT_STRESS_DRIVER
    }
    return d
  })
  const [rangeMap, setRangeMapState] = useState<FeatureRangeMap>(() => loadRangeMap(driverFeature))
  const [manualStress, setManualStress] = useState(initial)
  const [featureStress, setFeatureStress] = useState(initial)
  const [rangePreview, setRangePreview] = useState<{ src: number; dst: number } | null>(null)
  const smoothRef = useRef(initial)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const driverRef = useRef(driverFeature)
  driverRef.current = driverFeature
  const rangeRef = useRef(rangeMap)
  rangeRef.current = rangeMap
  const latestRef = useRef<ReturnType<typeof useFeatureMonitor>['latest']>(null)
  const displayHistRef = useRef<number[]>([])

  const setMode = useCallback((m: SignalControlMode) => {
    setModeState(m)
    saveSignalMode(m)
  }, [])

  const setDriverFeature = useCallback((id: string) => {
    setDriverFeatureState(id)
    saveStressDriver(id)
    const next = loadRangeMap(id)
    setRangeMapState(next)
    rangeRef.current = next
    displayHistRef.current = []
  }, [])

  const setRangeMap = useCallback((next: FeatureRangeMap) => {
    setRangeMapState(next)
    rangeRef.current = next
    saveRangeMap(driverRef.current, next)
  }, [])

  const resetRangeMap = useCallback(() => {
    setRangeMap(defaultRangeForDriver(driverRef.current))
  }, [setRangeMap])

  const captureRangeFromWindow = useCallback(() => {
    const hist = displayHistRef.current
    if (hist.length < 5) return
    let lo = hist[0]!
    let hi = hist[0]!
    for (const v of hist) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (hi - lo < 1e-6) {
      lo -= 1
      hi += 1
    }
    setRangeMap({
      ...rangeRef.current,
      inMin: roundRangeEdge(lo),
      inMax: roundRangeEdge(hi),
    })
  }, [setRangeMap])

  const manualMods =
    opts?.manualModulators?.(manualStress) ??
    ({
      stress: manualStress,
      focus: 100 - manualStress * 0.3,
      arousal: 30 + manualStress * 0.55,
    } satisfies FeatureModulators)

  const features = useFeatureMonitor({
    active: true,
    autonomous: mode === 'features',
    preferLive: mode === 'live',
    modulators: mode === 'manual' ? manualMods : undefined,
    ensureFeatures: [
      ...ensureIdsForDriver(driverFeature),
      'rms',
      'std',
      'pow_freq_bands',
    ],
  })
  latestRef.current = features.latest

  useEffect(() => {
    if (mode !== 'features' && mode !== 'live') return
    const id = window.setInterval(() => {
      const t = performance.now() / 1000
      const envelope = autonomousModulators(t).stress ?? 50
      const driver = driverRef.current
      const profile = adaptProfileForDriver(driver)
      let target: number | null = null

      if (driver !== DEMO_ENVELOPE_DRIVER) {
        const snap = latestRef.current
        const raw = snap ? resolveDriverRaw(snap.values, driver) : undefined
        if (raw !== undefined) {
          const src = displayValueForDriver(driver, raw)
          const dst = applyRangeMap(src, rangeRef.current)
          const hist = displayHistRef.current
          if (Number.isFinite(src)) {
            hist.push(src)
            if (hist.length > DISPLAY_HIST) hist.shift()
          }
          setRangePreview({
            src: Math.round(src * 10) / 10,
            dst: Math.round(dst * 10) / 10,
          })
          target = dst
        }
      } else if (modeRef.current === 'features') {
        target = envelope
        setRangePreview(null)
      }

      if (target == null) {
        if (modeRef.current === 'live') return
        target = envelope
      }

      const alpha = profile.kind === 'identity' ? 1 : profile.ema
      smoothRef.current = alpha >= 1 ? target : ema(smoothRef.current, target, alpha)
      const next = Math.round(smoothRef.current * 10) / 10
      setFeatureStress((prev) => (Math.abs(prev - next) < 0.05 ? prev : next))
    }, 100)
    return () => clearInterval(id)
  }, [mode])

  const stress = mode === 'manual' ? manualStress : featureStress

  const takeManualControl = useCallback(
    (v: number) => {
      setManualStress(clamp100(v))
      if (modeRef.current !== 'manual') setMode('manual')
    },
    [setMode],
  )

  const setManualStressQuiet = useCallback((v: number) => {
    setManualStress(clamp100(v))
  }, [])

  return {
    mode,
    setMode,
    driverFeature,
    setDriverFeature,
    rangeMap,
    setRangeMap,
    resetRangeMap,
    captureRangeFromWindow,
    rangePreview,
    stress,
    setStress: takeManualControl,
    takeManualControl,
    setManualStressQuiet,
    manualStress,
    featureStress,
    features,
  }
}
