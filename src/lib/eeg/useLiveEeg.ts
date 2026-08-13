import { useEffect, useState } from 'react'
import { liveEegHub, type LiveEegMeta } from './liveHub'

export type LiveEegView = {
  live: boolean
  stale: boolean
  meta: LiveEegMeta
  lastAt: number
}

/** Subscribe to hub meta + freshness (polls so stale/live flips without new events). */
export function useLiveEeg(): LiveEegView {
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = liveEegHub.subscribe(() => setTick((t) => t + 1))
    const id = window.setInterval(() => setTick((t) => t + 1), 400)
    return () => {
      unsub()
      window.clearInterval(id)
    }
  }, [])

  const meta = liveEegHub.meta
  const live = liveEegHub.isFresh()
  const stale = (meta.link === 'streaming' || meta.link === 'demo') && !live
  return { live, stale, meta, lastAt: meta.lastAt }
}
