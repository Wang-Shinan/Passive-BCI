/** Wait for the next animation frame. */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

/**
 * Double-rAF then sample performance.now().
 * Use this as the stimulus onset timestamp so React paint latency is excluded.
 */
export async function calibratedNow(): Promise<number> {
  await nextFrame()
  await nextFrame()
  return performance.now()
}

/** Prefer KeyboardEvent.timeStamp (DOMHighResTimeStamp) over performance.now() for RT. */
export function keyTimestamp(e: KeyboardEvent | PointerEvent): number {
  return e.timeStamp
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}
