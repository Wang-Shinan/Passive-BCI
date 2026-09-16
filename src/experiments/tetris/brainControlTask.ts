export type BrainControlTask = 'smr_control' | 'gaze_smr'

export function normalizeBrainControlTask(value: unknown): BrainControlTask {
  return value === 'gaze_smr' ? 'gaze_smr' : 'smr_control'
}

type BrainHello = {
  model_type?: string
  task?: string
  class_names?: readonly string[]
  model_revision?: string
}
type BrainPrediction = {
  task?: string
  class_names: readonly string[]
  probabilities: readonly number[]
  model_revision: string
  received_at_ms: number
  output_semantics?: string
}

/** Task identity, ordered labels and revision must agree before a prediction can drive actions. */
export function acceptsBrainPrediction(
  task: BrainControlTask,
  hello: BrainHello | null | undefined,
  prediction: BrainPrediction | null | undefined,
  now: number,
  after = 0,
): boolean {
  if (!prediction || hello?.model_type !== 'reve' || hello.task !== task || prediction.task !== task) return false
  const classes = task === 'smr_control' ? 'left_hand|right_hand|both_hand|rest' : 'left|right|up|down'
  const semantics = task === 'smr_control' ? 'smr_control_4' : 'gaze_smr_direction_4'
  if (prediction.class_names.join('|') !== classes || (hello.class_names && hello.class_names.join('|') !== classes)) return false
  if (prediction.output_semantics && prediction.output_semantics !== semantics) return false
  if (hello.model_revision && prediction.model_revision !== hello.model_revision) return false
  if (prediction.probabilities.length !== 4 || prediction.probabilities.some(v => !Number.isFinite(v) || v < 0)
    || prediction.probabilities.reduce((a, b) => a + b, 0) <= 0) return false
  return Number.isFinite(prediction.received_at_ms) && Number.isFinite(now)
    && prediction.received_at_ms >= after && prediction.received_at_ms <= now
    && now - prediction.received_at_ms <= 1000
}
