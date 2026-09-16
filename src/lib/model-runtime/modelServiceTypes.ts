export type ModelServiceBackend = 'reve' | 'mock'

export type ModelServiceEnsureResult = {
  headId?: string | null
  configurationKey?: string | null
  gazeReport?: GazeModelReport | null
  modelRevision?: string | null
  loadedHead?: string | null
  ok: boolean
  backend: ModelServiceBackend | null
  task?: string | null
  stepSec?: number | null
  port: number
  running: boolean
  owned: boolean
  pid: number | null
  alreadyRunning: boolean
  starting: boolean
  message?: string
  logTail?: string
}


export type GazeModelReport = {
  task: 'gaze_smr'; subjectId: string; channels: string[]; sampleRate: number
  modelRevision: string; encoderId: string; classNames: string[]; activeClasses: string[]
  trials: number; bootstrapGazeOnly: boolean
  evaluation: { n: number; balancedAccuracy: number | null; recalls: (number | null)[] }
}

export type ModelHeadOption = {
  trainedAt?: string | null; updatedAt?: string | null
  gazeReport?: GazeModelReport | null; configurationKey?: string | null
  id: string; name: string; task: string | null; encoderId: string | null
  classes: number | null; available: boolean; reason: string
}
