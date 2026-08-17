import { useSyncExternalStore } from 'react'
import { modelRuntimeHub, type ModelRuntimeSnapshot } from './modelRuntimeHub'

export function useModelRuntime(): ModelRuntimeSnapshot {
  return useSyncExternalStore(
    (listener) => modelRuntimeHub.subscribe(listener),
    () => modelRuntimeHub.snapshot,
    () => modelRuntimeHub.snapshot,
  )
}
