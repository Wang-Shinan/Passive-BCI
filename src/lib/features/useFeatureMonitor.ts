import { useCallback, useEffect, useRef, useState } from 'react'
import {
  computeLiveFeatures,
  type LiveFeatureSnapshot,
} from './bandFeatures'
import {
  loadEnabledFeatures,
  saveEnabledFeatures,
} from './featureCatalog'
import {
  autonomousModulators,
  makeSynthRing,
  pushSynthFrame,
  SYNTH_FS,
  synthEegSample,
  type FeatureModulators,
} from './synthEeg'

const HISTORY = 60
const WINDOW_SEC = 1.0

/**
 * Shared feature monitor for experiment pages:
 * synthesizes EEG and runs the same sliding-window feature pipeline as acquisition.
 *
 * - `autonomous: true` → drifting modulators independent of control outputs (for feature→control)
 * - otherwise uses `modulators` (typically manual slider values)
 */
export function useFeatureMonitor(opts: {
  active?: boolean
  modulators?: FeatureModulators
  /** When true, ignore modulators and use autonomous drifts (no control feedback). */
  autonomous?: boolean
  /** Extra feature ids that must stay enabled (e.g. control drivers). */
  ensureFeatures?: string[]
}) {
  const { active = true, modulators, autonomous = false, ensureFeatures = [] } = opts
  const [enabledIds, setEnabledIds] = useState<string[]>(() => loadEnabledFeatures())
  const [latest, setLatest] = useState<LiveFeatureSnapshot | null>(null)
  const [history, setHistory] = useState<LiveFeatureSnapshot[]>([])

  const ringRef = useRef(makeSynthRing(5))
  const phaseRef = useRef(0)
  const modulatorsRef = useRef(modulators)
  modulatorsRef.current = modulators
  const autonomousRef = useRef(autonomous)
  autonomousRef.current = autonomous

  const effectiveEnabled = useCallback(() => {
    const set = new Set(enabledIds)
    for (const id of ensureFeatures) {
      // Map display keys like rel_power_beta → enable parent pow_freq_bands
      if (id.startsWith('rel_power_')) set.add('pow_freq_bands')
      else if (id.startsWith('energy_')) set.add('energy_freq_bands')
      else set.add(id)
    }
    return [...set]
  }, [enabledIds, ensureFeatures])

  const onEnabledChange = useCallback((ids: string[]) => {
    setEnabledIds(ids)
    saveEnabledFeatures(ids)
  }, [])

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => {
      const batch = 25
      for (let s = 0; s < batch; s++) {
        const t = (phaseRef.current + s) / SYNTH_FS
        const mods = autonomousRef.current
          ? autonomousModulators(t)
          : modulatorsRef.current
        pushSynthFrame(ringRef.current, synthEegSample(t, mods))
      }
      phaseRef.current += batch
    }, 100)
    return () => clearInterval(id)
  }, [active])

  useEffect(() => {
    if (!active) {
      setLatest(null)
      return
    }
    const enabled = effectiveEnabled()
    if (!enabled.length) {
      setLatest(null)
      return
    }
    const id = window.setInterval(() => {
      const ring = ringRef.current
      const snap = computeLiveFeatures({
        buffers: ring.buffers,
        writeHead: ring.writeHead,
        filled: ring.filled,
        sampleRate: SYNTH_FS,
        windowSec: WINDOW_SEC,
        enabledFeatures: enabled,
      })
      if (!snap) return
      setLatest(snap)
      setHistory((prev) => {
        const next = [...prev, snap]
        return next.length > HISTORY ? next.slice(-HISTORY) : next
      })
    }, 200)
    return () => clearInterval(id)
  }, [active, effectiveEnabled])

  return {
    enabledIds,
    onEnabledChange,
    latest,
    history,
    analyzing: active,
  }
}
