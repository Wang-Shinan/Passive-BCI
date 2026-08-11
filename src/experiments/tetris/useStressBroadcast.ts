import { useEffect, useRef } from 'react'
import {
  publishStress,
  STRESS_CHANNEL,
  type StressHello,
  type StressMessage,
  type StressPacket,
} from './stressChannel'
import type { SignalControlMode } from '../../lib/features'

/**
 * Sync stress with the optional remote window.
 * - Continuous publishes are origin:'sync' and must not steal feature/demo mode.
 * - Remote user gestures arrive as origin:'user' → takeManualControl.
 */
export function useStressBroadcast(
  stress: number,
  opts: {
    mode: SignalControlMode
    takeManualControl: (v: number) => void
    setManualStressQuiet: (v: number) => void
  },
) {
  const stressRef = useRef(stress)
  stressRef.current = stress
  const modeRef = useRef(opts.mode)
  modeRef.current = opts.mode
  const takeManualRef = useRef(opts.takeManualControl)
  takeManualRef.current = opts.takeManualControl
  const quietRef = useRef(opts.setManualStressQuiet)
  quietRef.current = opts.setManualStressQuiet

  useEffect(() => {
    const ch = new BroadcastChannel(STRESS_CHANNEL)
    ch.onmessage = (ev: MessageEvent<StressPacket>) => {
      const msg = ev.data
      if (msg.type === 'stress') {
        const origin = msg.origin ?? 'user'
        if (origin === 'sync') {
          // Mirror only while manual; never kick demo/feature mode off.
          if (modeRef.current === 'manual') quietRef.current(msg.value)
          return
        }
        takeManualRef.current(msg.value)
        return
      }
      if (msg.type === 'request' || msg.type === 'hello') {
        ch.postMessage({
          type: 'stress',
          value: stressRef.current,
          t: performance.now(),
          origin: 'sync',
        } satisfies StressMessage)
      }
    }
    ch.postMessage({ type: 'hello' } satisfies StressHello)
    return () => ch.close()
  }, [])

  useEffect(() => {
    publishStress(stress, 'sync')
  }, [stress])
}
