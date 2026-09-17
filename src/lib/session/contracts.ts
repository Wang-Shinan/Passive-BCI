import type { SampleClockSnapshot } from '../eeg/sampleClock'
import type { SystemClockStamp } from '../eeg/systemClock'

export const SESSION_SCHEMA = 'passive-bci.session.v1'
export const EVENT_SCHEMA = 'passive-bci.event.v1'
export const CONTEXT_SCHEMA = 'passive-bci.context.v1'

export type SessionEventRecord = {
  systemClock?: SystemClockStamp
  schema: typeof EVENT_SCHEMA
  t_ms: number
  perf_ms: number
  experiment: string
  subjectId: string
  type: string
  data?: Record<string, unknown>
  eeg: SampleClockSnapshot | null
}

export type SessionContextRecord = {
  schema: typeof CONTEXT_SCHEMA
  t_ms: number
  perf_ms: number
  experiment: string
  subjectId: string
  eeg: SampleClockSnapshot | null
  [key: string]: unknown
}

export type SessionBindMeta = {
  experiment?: string
  subjectId?: string
  game?: string
  seed?: number
  notes?: string
}
