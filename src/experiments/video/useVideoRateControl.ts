import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { playbackRateForControl, playbackRateForThreshold } from './control'

export type VideoRateControlMode = 'continuous' | 'threshold'

export type RateSettledInfo = {
  mediaTime: number
  rate: number
  target: number
  control: number
  driver: string
  mode: string
}

export type VideoRateControlOptions = {
  video: RefObject<HTMLVideoElement | null>
  enabled: boolean
  controlMode: VideoRateControlMode
  control: number
  threshold: number
  minRate: number
  maxRate: number
  outMin: number
  outMax: number
  driver: string
  mode: string
  onSettled?: (info: RateSettledInfo) => void
}

/**
 * Control channel → playbackRate for the video experiment.
 *
 * targetRate is derived synchronously from the current render — never stored
 * in effect-populated mutable state — so a missed or stale commit can never
 * freeze the target at its initial value. One 80ms loop lives for the whole
 * component lifetime and reads the latest committed snapshot through a ref;
 * EEG ticks and rate feedback never restart the timer.
 *
 * - continuous: ease el.playbackRate 25% toward target per tick (snap <0.005);
 *   defaultPlaybackRate tracks target so (re)loads land on it; paused keeps
 *   the actual rate untouched while target/default still update.
 * - threshold: two-bucket rate — below `threshold` 1×, at/above 2× — applied
 *   directly to playbackRate/defaultPlaybackRate even while paused or ended
 *   (so resume lands on it); never plays, pauses, or replays the media.
 * - disabled: restores both rates to 1× immediately and leaves play state alone.
 */
export function useVideoRateControl(opts: VideoRateControlOptions): { targetRate: number; appliedRate: number } {
  const { video, enabled, controlMode, control, threshold, minRate, maxRate, outMin, outMax } = opts
  const targetRate = enabled
    ? controlMode === 'threshold'
      ? playbackRateForThreshold(control, threshold)
      : playbackRateForControl(control, minRate, maxRate, outMin, outMax)
    : 1
  const [appliedRate, setAppliedRate] = useState(1)
  const rateLoggedAt = useRef(0)
  const ctx = useRef({
    enabled, controlMode, control, threshold, targetRate,
    driver: opts.driver, mode: opts.mode, onSettled: opts.onSettled,
  })
  // The interval reads only this committed snapshot, populated after each render.
  useEffect(() => {
    ctx.current = {
      enabled, controlMode, control, threshold, targetRate,
      driver: opts.driver, mode: opts.mode, onSettled: opts.onSettled,
    }
  })

  // Disabled restores 1× without waiting for the next tick; switching into
  // threshold applies the fixed bucket immediately (never restarts the timer).
  useEffect(() => {
    const el = video.current
    if (!el) return
    if (!enabled) {
      if (el.defaultPlaybackRate !== 1) el.defaultPlaybackRate = 1
      if (el.playbackRate !== 1) el.playbackRate = 1
      setAppliedRate(1)
    } else if (controlMode === 'threshold') {
      if (el.defaultPlaybackRate !== targetRate) el.defaultPlaybackRate = targetRate
      if (el.playbackRate !== targetRate) el.playbackRate = targetRate
      setAppliedRate(el.playbackRate)
    }
  }, [video, enabled, controlMode, targetRate])

  useEffect(() => {
    const id = window.setInterval(() => {
      const el = video.current
      if (!el) return
      const c = ctx.current
      if (!c.enabled) {
        if (el.defaultPlaybackRate !== 1) el.defaultPlaybackRate = 1
        if (el.playbackRate !== 1) el.playbackRate = 1
        return
      }
      if (c.controlMode === 'threshold') {
        // Two-bucket rate only; play/pause state is the user's, never ours.
        if (el.defaultPlaybackRate !== c.targetRate) el.defaultPlaybackRate = c.targetRate
        if (el.playbackRate !== c.targetRate) el.playbackRate = c.targetRate
        const shown = el.playbackRate
        setAppliedRate(prev => (Math.abs(prev - shown) > 0.01 ? shown : prev))
        return
      }
      const target = c.targetRate
      if (Math.abs(el.defaultPlaybackRate - target) > 0.01) el.defaultPlaybackRate = target
      const active = !el.paused && !el.ended
      if (active) {
        const cur = el.playbackRate
        const eased = Math.abs(cur + (target - cur) * 0.25 - target) < 0.005 ? target : cur + (target - cur) * 0.25
        if (Math.abs(eased - cur) > 0.002) el.playbackRate = eased
      }
      const shown = el.playbackRate
      setAppliedRate(prev => (Math.abs(prev - shown) > 0.01 ? shown : prev))
      if (active && performance.now() - rateLoggedAt.current > 1000 && Math.abs(el.playbackRate - target) <= 0.01) {
        rateLoggedAt.current = performance.now()
        c.onSettled?.({ mediaTime: el.currentTime, rate: el.playbackRate, target, control: c.control, driver: c.driver, mode: c.mode })
      }
    }, 80)
    return () => clearInterval(id)
  }, [video])

  return { targetRate, appliedRate }
}
