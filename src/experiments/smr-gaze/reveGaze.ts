import { normalizeGazePrediction } from './gazeModelContract'
import { modelRuntimeHub } from '../../lib/model-runtime/modelRuntimeHub'
import { ensureModelService } from '../../lib/model-runtime/modelServiceApi'
import { DIRECTIONS } from './classifier'

export const BASELINE_SEC = 3
export const TARGET_SEC = 6
export type GazeReport = {
  subjectId: string; channels: string[]; sampleRate: number; modelRevision: string
  trials: number; bootstrapGazeOnly: boolean
  activeClasses?: string[]
  evaluation: { n: number; balancedAccuracy: number | null; recalls: (number | null)[] }
}
export async function gazeModel(session?: string, subject?: string, headId = ''): Promise<GazeReport | null> {
  const response = await fetch(`/api/model-service/${session ? 'fit-gaze-smr' : `gaze-smr-model?headId=${encodeURIComponent(headId)}`}`, session ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, subject }),
  } : undefined)
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.message || 'REVE 模型接口失败')
  return result.model
}
export async function connectGazeModel(headId = '') {
  await ensureModelService({ backend: 'reve', task: 'gaze_smr', headId, stepSec: 0.2, force: true })
  modelRuntimeHub.setEnabled(true)
}
export function gazePrediction(model: GazeReport, after = 0) {
  const { serviceHello: hello, latestPrediction: p } = modelRuntimeHub.snapshot
  if (hello?.model_type !== 'reve' || hello.task !== 'gaze_smr' || !p || p.task !== 'gaze_smr'
    || p.model_revision !== model.modelRevision || p.received_at_ms < after
    || performance.now() - p.received_at_ms > 1000
    || p.class_names.join('|') !== DIRECTIONS.join('|')
    || p.probabilities.length !== 4 || p.probabilities.some(v => !Number.isFinite(v) || v < 0)) return null
  return normalizeGazePrediction(p, { modelRevision: model.modelRevision, activeClasses: model.activeClasses ?? [...DIRECTIONS] })
}
