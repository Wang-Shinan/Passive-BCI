import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AFFECT_DRIVER_DEFAULTS,
  ema,
  loadSignalMode,
  mapFeatureToControl100,
  resolveDriverRaw,
  saveSignalMode,
  type AffectChannel,
  type SignalControlMode,
} from './controlMapping'
import { useFeatureMonitor } from './useFeatureMonitor'
import type { FeatureModulators } from './synthEeg'

export type AffectSignals = Record<AffectChannel, number>

const DEFAULT_AFFECT: AffectSignals = {
  satisfaction: 50,
  surprise: 40,
  focus: 55,
  arousal: 45,
}

/**
 * Four affective channels for draw-guess: manual sliders OR feature-driven.
 */
export function useAffectControl(initial?: Partial<AffectSignals>) {
  const [mode, setModeState] = useState<SignalControlMode>(() => loadSignalMode())
  const [manual, setManual] = useState<AffectSignals>({ ...DEFAULT_AFFECT, ...initial })
  const [derived, setDerived] = useState<AffectSignals>({ ...DEFAULT_AFFECT, ...initial })
  const smoothRef = useRef<AffectSignals>({ ...DEFAULT_AFFECT, ...initial })
  const modeRef = useRef(mode)
  modeRef.current = mode

  const setMode = useCallback((m: SignalControlMode) => {
    setModeState(m)
    saveSignalMode(m)
  }, [])

  const manualMods: FeatureModulators = {
    focus: manual.focus,
    arousal: manual.arousal,
    relaxation: manual.satisfaction,
    stress: Math.max(
      0,
      40 + (manual.surprise - 50) * 0.4 + (100 - manual.satisfaction) * 0.25,
    ),
  }

  const ensure = [
    ...Object.values(AFFECT_DRIVER_DEFAULTS),
    'rms',
    'std',
    'hjorth_complexity',
    'pow_freq_bands',
    'relaxation_score',
    'energy_freq_bands',
  ]

  const features = useFeatureMonitor({
    active: true,
    autonomous: mode === 'features',
    modulators: mode === 'manual' ? manualMods : undefined,
    ensureFeatures: ensure,
  })

  useEffect(() => {
    if (mode !== 'features') return
    const snap = features.latest
    if (!snap) return
    const next = { ...smoothRef.current }
    let changed = false
    for (const ch of Object.keys(AFFECT_DRIVER_DEFAULTS) as AffectChannel[]) {
      const fid = AFFECT_DRIVER_DEFAULTS[ch]
      const raw = resolveDriverRaw(snap.values, fid)
      if (raw === undefined) continue
      const mapped = mapFeatureToControl100(fid, raw)
      next[ch] = ema(next[ch], mapped, 0.18)
      changed = true
    }
    if (!changed) return
    smoothRef.current = next
    setDerived({
      satisfaction: Math.round(next.satisfaction * 10) / 10,
      surprise: Math.round(next.surprise * 10) / 10,
      focus: Math.round(next.focus * 10) / 10,
      arousal: Math.round(next.arousal * 10) / 10,
    })
  }, [features.latest, mode])

  const signals = mode === 'manual' ? manual : derived

  const updateSignal = useCallback(
    (key: AffectChannel, value: number) => {
      const clamped = Math.max(0, Math.min(100, value))
      setManual((prev) => ({ ...prev, [key]: clamped }))
      // Only leave demo mode on explicit user gesture (slider drag).
      if (modeRef.current === 'features') setMode('manual')
    },
    [setMode],
  )

  const resetSignals = useCallback((next?: Partial<AffectSignals>) => {
    const merged = { ...DEFAULT_AFFECT, ...next }
    setManual(merged)
    setDerived(merged)
    smoothRef.current = merged
  }, [])

  return {
    mode,
    setMode,
    signals,
    updateSignal,
    resetSignals,
    drivers: AFFECT_DRIVER_DEFAULTS,
    features,
  }
}
