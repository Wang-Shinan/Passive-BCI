import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEMO_ENVELOPE_DRIVER,
  adaptiveScale100,
  ema,
  loadSignalMode,
  loadStressDriver,
  mapFeatureToControl100,
  saveSignalMode,
  saveStressDriver,
  type SignalControlMode,
} from './controlMapping'
import { useFeatureMonitor } from './useFeatureMonitor'
import { autonomousModulators, type FeatureModulators } from './synthEeg'

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v))
}

/**
 * Stress (0–100) for games: manual slider OR demo/feature-driven.
 *
 * Demo mode updates on its own 10 Hz timer so the stress panel visibly tracks
 * the autonomous envelope (not a compressed softScore that looks flat).
 */
export function useStressControl(opts?: {
  initial?: number
  manualModulators?: (stress: number) => FeatureModulators
}) {
  const initial = opts?.initial ?? 40
  const [mode, setModeState] = useState<SignalControlMode>(() => loadSignalMode())
  const [driverFeature, setDriverFeatureState] = useState(() => {
    const d = loadStressDriver()
    // Previous default (cognitive_load + softScore) barely moved the stress UI.
    if (d === 'cognitive_load') {
      saveStressDriver(DEMO_ENVELOPE_DRIVER)
      return DEMO_ENVELOPE_DRIVER
    }
    return d
  })
  const [manualStress, setManualStress] = useState(initial)
  const [featureStress, setFeatureStress] = useState(initial)
  const smoothRef = useRef(initial)
  const adaptRef = useRef({ min: 40, max: 60 })
  const modeRef = useRef(mode)
  modeRef.current = mode
  const driverRef = useRef(driverFeature)
  driverRef.current = driverFeature
  const latestRef = useRef<ReturnType<typeof useFeatureMonitor>['latest']>(null)

  const setMode = useCallback((m: SignalControlMode) => {
    setModeState(m)
    saveSignalMode(m)
    if (m === 'features') {
      // Reset adaptive window when entering demo so scale can re-learn.
      adaptRef.current = { min: 40, max: 60 }
    }
  }, [])

  const setDriverFeature = useCallback((id: string) => {
    setDriverFeatureState(id)
    saveStressDriver(id)
    adaptRef.current = { min: 40, max: 60 }
  }, [])

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
    modulators: mode === 'manual' ? manualMods : undefined,
    ensureFeatures: [
      driverFeature === DEMO_ENVELOPE_DRIVER ? 'cognitive_load' : driverFeature,
      'cognitive_load',
      'pow_freq_bands',
      'focus_score',
      'engagement_score',
    ],
  })
  latestRef.current = features.latest

  // Dedicated demo clock — stress panel must move even if feature softScore is flat.
  useEffect(() => {
    if (mode !== 'features') return
    const id = window.setInterval(() => {
      const t = performance.now() / 1000
      const envelope = autonomousModulators(t).stress ?? 50
      const driver = driverRef.current
      let target = envelope

      if (driver !== DEMO_ENVELOPE_DRIVER) {
        const raw = latestRef.current?.values[driver]
        if (raw !== undefined && Number.isFinite(raw)) {
          const mapped = mapFeatureToControl100(driver, raw)
          target = adaptiveScale100(mapped, adaptRef.current)
          // If adaptive span still tiny, blend with envelope so UI never looks frozen.
          const span = adaptRef.current.max - adaptRef.current.min
          if (span < 5) target = 0.55 * envelope + 0.45 * target
        } else {
          target = envelope
        }
      }

      smoothRef.current = ema(smoothRef.current, target, 0.45)
      const next = Math.round(smoothRef.current * 10) / 10
      setFeatureStress((prev) => (Math.abs(prev - next) < 0.05 ? prev : next))
    }, 100)
    return () => clearInterval(id)
  }, [mode])

  const stress = mode === 'manual' ? manualStress : featureStress

  const takeManualControl = useCallback(
    (v: number) => {
      setManualStress(clamp100(v))
      if (modeRef.current === 'features') setMode('manual')
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
    stress,
    setStress: takeManualControl,
    takeManualControl,
    setManualStressQuiet,
    manualStress,
    featureStress,
    features,
  }
}
