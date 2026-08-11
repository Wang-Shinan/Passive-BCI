export const STRESS_CHANNEL = 'passive-bci-stress'

export interface StressMessage {
  type: 'stress'
  value: number
  t: number
  /** user = experimenter gesture; sync = mirror / hello reply (must not steal feature mode). */
  origin?: 'user' | 'sync'
}

export interface StressHello {
  type: 'hello' | 'request'
}

export type StressPacket = StressMessage | StressHello

export function publishStress(value: number, origin: 'user' | 'sync' = 'sync'): void {
  const ch = new BroadcastChannel(STRESS_CHANNEL)
  ch.postMessage({
    type: 'stress',
    value,
    t: performance.now(),
    origin,
  } satisfies StressMessage)
  ch.close()
}
