import type { ModelPrediction } from '../../lib/model-runtime/contracts'
import type { GazeModelReport } from '../../lib/model-runtime/modelServiceTypes'
export function gazeReportMatchesSource(report: GazeModelReport | null | undefined, subject: string,
  channels: readonly string[], sampleRate: number): boolean {
  return Boolean(report && report.subjectId === subject && report.sampleRate === sampleRate
    && report.channels.join('|') === channels.join('|'))
}
export function normalizeGazePrediction<T extends Pick<ModelPrediction, 'probabilities' | 'model_revision'>>(prediction: T,
  report: Pick<GazeModelReport, 'modelRevision' | 'activeClasses'>): T | null {
  if (prediction.model_revision !== report.modelRevision || prediction.probabilities.length !== 4
    || prediction.probabilities.some(p => !Number.isFinite(p) || p < 0)) return null
  if (report.activeClasses?.join('|') !== 'left|right') return prediction
  const total = prediction.probabilities[0]! + prediction.probabilities[1]!
  if (total <= 1e-8) return null
  const probabilities = [prediction.probabilities[0]! / total, prediction.probabilities[1]! / total, 0, 0]
  const class_id = probabilities[0]! >= probabilities[1]! ? 0 : 1
  return { ...prediction, probabilities, class_id, class_name: class_id === 0 ? 'left' : 'right',
    confidence: probabilities[class_id], logits: probabilities.map(p => p > 0 ? Math.log(p) : -1e9) }
}
