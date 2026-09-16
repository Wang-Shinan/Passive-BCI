import { useEffect, useState, useSyncExternalStore } from 'react'
import { modelConfigurationLocked, preferredModelHead, subscribeModelHeadPreference, getAppliedModel, subscribeAppliedModel } from './modelServiceApi'
import { modelOperation } from './modelOperation'
import { sessionHub } from '../session/sessionHub'

export function useModelConfiguration(task: string) {
  const headId = useSyncExternalStore(subscribeModelHeadPreference, () => preferredModelHead(task), () => '')
  const busy = useSyncExternalStore(modelOperation.subscribe, () => modelOperation.busy, () => false)
  const [recording, setRecording] = useState(modelConfigurationLocked)
  useEffect(() => {
    const update = () => setRecording(modelConfigurationLocked())
    const unsubscribe = sessionHub.subscribe(update)
    const timer = setInterval(update, 200)
    return () => { clearInterval(timer); unsubscribe() }
  }, [])
  return { headId, busy, recording, locked: busy || recording }
}

export function useAppliedModel() { return useSyncExternalStore(subscribeAppliedModel, getAppliedModel, () => null) }
