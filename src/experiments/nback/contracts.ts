import type { Result, Trial } from './engine.ts'

export type NBackSave = {
  id: string
  revision: number
  subjectId: string
  startedAt: string
  updatedAt: string
  status: 'running' | 'complete' | 'interrupted'
  reason: string
  seed: number
  config: { n: number; count: number; stimulusMs: number; intervalMs: number }
  trials: Trial[]
  results: Result[]
  events: { t: number; experiment: string; type: string; data?: Record<string, unknown> }[]
  eegSessionRel: string | null
}
