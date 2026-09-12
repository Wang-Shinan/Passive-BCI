/** Server handles one window header at a time; extra in-flight frames can desync. */
export const MAX_IN_FLIGHT = 1
export const MAX_PENDING = 2
export const MAX_SOCKET_BUFFERED = 256 * 1024

export function inFlightTimeoutMs(stepSec: number): number {
  return Math.max(4000, Math.round(stepSec * 8000))
}

export function collectExpiredInFlight(
  sentAt: Iterable<readonly [string, number]>,
  now: number,
  timeoutMs: number,
): string[] {
  const expired: string[] = []
  for (const [id, sent] of sentAt) {
    if (now - sent >= timeoutMs) expired.push(id)
  }
  return expired
}
