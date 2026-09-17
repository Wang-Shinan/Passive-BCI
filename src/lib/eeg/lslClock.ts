export type LslTiming = {
  timestampsSec: number[]
  correctionSec: number | null
  correctionAtSec: number
  streamId: string
}

/** Bridge local_clock milliseconds minus browser performance.now milliseconds. */
export class LslClock {
  private probes: { at: number; offsetMs: number; rttMs: number }[] = []
  reset() { this.probes = [] }
  observe(sentMs: number, receivedMs: number, serverReceiveSec: number, serverSendSec: number) {
    if (![sentMs, receivedMs, serverReceiveSec, serverSendSec].every(Number.isFinite)
      || receivedMs < sentMs || serverSendSec < serverReceiveSec) return
    const rttMs = receivedMs - sentMs - (serverSendSec - serverReceiveSec) * 1000
    if (rttMs < -1 || rttMs > 2000) return
    this.probes = this.probes.filter(p => receivedMs - p.at < 30000)
    this.probes.push({ at: receivedMs, rttMs: Math.max(0, rttMs),
      offsetMs: ((serverReceiveSec + serverSendSec) * 1000 - sentMs - receivedMs) / 2 })
  }
  mapping(nowMs: number) {
    const best = this.probes.filter(p => nowMs >= p.at && nowMs - p.at < 30000).sort((a, b) => a.rttMs - b.rttMs)[0]
    return best ? { ...best, ageMs: nowMs - best.at } : null
  }
}
export const lslClock = new LslClock()
