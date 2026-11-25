import { CUE_SEC, FEEDBACK_SEC, ITI_SEC, POST_SEC } from '../smr-adapt/engine'

export const smrTrialSeconds = { prepare: ITI_SEC, cue: CUE_SEC, imagery: FEEDBACK_SEC, recover: POST_SEC } as const
