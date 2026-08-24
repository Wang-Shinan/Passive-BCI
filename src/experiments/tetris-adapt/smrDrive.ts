import { liveEegHub } from '../../lib/eeg/liveHub'
import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import {
  SMR_WINDOW_SEC,
  alphaPower,
  copyRecentSamples,
  laplacianTrace,
  smrFeatures,
  type LaplacianMontage,
} from '../smr-adapt/smrControl'
import { axesFromReve } from './smrMap'

export function laplacianFeatures(montage: LaplacianMontage): { horiz: number; vert: number } | null {
  const { buffers, writeHead, filled, sampleRate } = liveEegHub.ring
  const n = Math.round(sampleRate * SMR_WINDOW_SEC)
  const c3Buf = buffers[montage.c3]
  const c4Buf = buffers[montage.c4]
  if (!c3Buf || !c4Buf) return null
  const c3 = copyRecentSamples(c3Buf, writeHead, filled, n)
  const c4 = copyRecentSamples(c4Buf, writeHead, filled, n)
  if (c3.length < 20 || c4.length < 20) return null
  const nC3 = montage.neighborsC3.map((idx) => copyRecentSamples(buffers[idx]!, writeHead, filled, n))
  const nC4 = montage.neighborsC4.map((idx) => copyRecentSamples(buffers[idx]!, writeHead, filled, n))
  return smrFeatures(
    alphaPower(laplacianTrace(c3, nC3), sampleRate),
    alphaPower(laplacianTrace(c4, nC4), sampleRate),
  )
}

export function reveAxesFromPrediction(
  prediction: ModelPrediction | null,
): { zH: number; zV: number } | null {
  if (!prediction) return null
  return axesFromReve(prediction.class_names, prediction.probabilities)
}
