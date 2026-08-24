import { useCallback, useEffect, useRef, useState } from 'react'
import { liveEegHub } from '../eeg/liveHub'
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

export type FeatureOrigin = 'live' | 'synth' | 'stale'

/**
 * Shared feature monitor for experiment pages.
 *
 * - Live hub fresh → real EEG (unless `autonomous` demo mode, which stays synth)
 * - `preferLive` → never synth; wait for hub
 * - After a live session goes stale → freeze last snapshot (do not synth)
 * - otherwise synthesize EEG with optional modulators
 */
export function useFeatureMonitor(opts: {
  active?: boolean
  modulators?: FeatureModulators
  /** When true, ignore modulators and use autonomous drifts (no control feedback). */
  autonomous?: boolean
  /** Use acquisition hub only; do not fall back to synthetic EEG. */
  preferLive?: boolean
  /** Extra feature ids that must stay enabled (e.g. control drivers). */
  ensureFeatures?: string[]
}) {
  const {
    active = true,
    modulators,
    autonomous = false,
    preferLive = false,
    ensureFeatures,
  } = opts
  const [enabledIds, setEnabledIds] = useState<string[]>(() => loadEnabledFeatures())
  const [latest, setLatest] = useState<LiveFeatureSnapshot | null>(null)
  const [history, setHistory] = useState<LiveFeatureSnapshot[]>([])
  const [origin, setOrigin] = useState<FeatureOrigin>('synth')

  const ringRef = useRef(makeSynthRing(5))
  const phaseRef = useRef(0)
  const sawLiveRef = useRef(false)
  const modulatorsRef = useRef(modulators)
  modulatorsRef.current = modulators
  const autonomousRef = useRef(autonomous)
  autonomousRef.current = autonomous
  const preferLiveRef = useRef(preferLive)
  preferLiveRef.current = preferLive
  const enabledIdsRef = useRef(enabledIds)
  enabledIdsRef.current = enabledIds
  const ensureRef = useRef(ensureFeatures)
  ensureRef.current = ensureFeatures

  const onEnabledChange = useCallback((ids: string[]) => {
    setEnabledIds(ids)
    saveEnabledFeatures(ids)
  }, [])

  const enabledNow = (): string[] => {
    const set = new Set(enabledIdsRef.current)
    for (const id of ensureRef.current ?? []) {
      if (id.startsWith('rel_power_')) set.add('pow_freq_bands')
      else if (id.startsWith('energy_')) set.add('energy_freq_bands')
      else set.add(id)
    }
    return [...set]
  }

  useEffect(() => {
    if (!preferLive) return
    if (!liveEegHub.isFresh()) {
      setLatest(null)
      setHistory([])
      setOrigin('live')
    }
  }, [preferLive])

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => {
      if (preferLiveRef.current) return
      if (!autonomousRef.current && liveEegHub.isFresh()) return
      if (sawLiveRef.current) return
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
    const id = window.setInterval(() => {
      const enabled = enabledNow()
      if (!enabled.length) return
      const wantLive = preferLiveRef.current || (!autonomousRef.current && liveEegHub.isFresh())
      if (wantLive) {
        if (!liveEegHub.isFresh()) {
          setOrigin(sawLiveRef.current ? 'stale' : 'live')
          return
        }
        const ring = liveEegHub.ring
        const snap = computeLiveFeatures({
          buffers: ring.buffers,
          writeHead: ring.writeHead,
          filled: ring.filled,
          sampleRate: ring.sampleRate,
          windowSec: WINDOW_SEC,
          enabledFeatures: enabled,
          channelMask: liveEegHub.featureChannelMask(),
          channelNames: liveEegHub.meta.channelNames,
        })
        if (!snap) return
        sawLiveRef.current = true
        setOrigin('live')
        setLatest(snap)
        setHistory((prev) => {
          const next = [...prev, snap]
          return next.length > HISTORY ? next.slice(-HISTORY) : next
        })
        return
      }

      if (preferLiveRef.current || sawLiveRef.current) {
        setOrigin(sawLiveRef.current ? 'stale' : 'live')
        return
      }

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
      setOrigin('synth')
      setLatest(snap)
      setHistory((prev) => {
        const next = [...prev, snap]
        return next.length > HISTORY ? next.slice(-HISTORY) : next
      })
    }, 200)
    return () => clearInterval(id)
  }, [active])

  return {
    enabledIds,
    onEnabledChange,
    latest,
    history,
    analyzing: active,
    origin,
  }
}
