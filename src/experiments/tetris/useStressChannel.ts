import { useEffect, useState } from 'react'
import {
  publishStress,
  STRESS_CHANNEL,
  type StressHello,
  type StressMessage,
  type StressPacket,
} from './stressChannel'

export function useStressChannel(initial = 40) {
  const [stress, setStressState] = useState(initial)

  useEffect(() => {
    let latest = initial
    const ch = new BroadcastChannel(STRESS_CHANNEL)
    ch.onmessage = (ev: MessageEvent<StressPacket>) => {
      const msg = ev.data
      if (msg.type === 'stress') {
        latest = msg.value
        setStressState(msg.value)
      }
      if (msg.type === 'request' || msg.type === 'hello') {
        ch.postMessage({
          type: 'stress',
          value: latest,
          t: performance.now(),
        } satisfies StressMessage)
      }
    }
    ch.postMessage({ type: 'hello' } satisfies StressHello)
    return () => ch.close()
  }, [initial])

  const setStress = (value: number) => {
    setStressState(value)
    publishStress(value)
  }

  return { stress, setStress }
}
