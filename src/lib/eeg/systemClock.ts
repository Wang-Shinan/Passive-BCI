/** Wall clock and monotonic clock are separate domains; never substitute either for device time. */
export type SystemClockStamp = {
  wallUnixMs: number
  monotonicMs: number
  timeOriginUnixMs: number
  monotonicUnixMs: number
  wallReadSpanMs: number
}

export function captureSystemClock(): SystemClockStamp {
  const before = performance.now()
  const wallUnixMs = Date.now()
  const after = performance.now()
  const monotonicMs = (before + after) / 2
  return { wallUnixMs, monotonicMs, timeOriginUnixMs: performance.timeOrigin,
    monotonicUnixMs: performance.timeOrigin + monotonicMs, wallReadSpanMs: after - before }
}
