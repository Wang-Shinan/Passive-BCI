export const STRESS_CHANNEL = 'passive-bci-stress'

export interface StressMessage {
  type: 'stress'
  value: number
  t: number
}

export interface StressHello {
  type: 'hello' | 'request'
}

export type StressPacket = StressMessage | StressHello

export function publishStress(value: number): void {
  const ch = new BroadcastChannel(STRESS_CHANNEL)
  ch.postMessage({ type: 'stress', value, t: performance.now() } satisfies StressMessage)
  ch.close()
}
