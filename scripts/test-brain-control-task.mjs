import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptsBrainPrediction, normalizeBrainControlTask } from '../src/experiments/tetris/brainControlTask.ts'

function fixture(task = 'smr_control') {
  const class_names = task === 'smr_control' ? ['left_hand', 'right_hand', 'both_hand', 'rest'] : ['left', 'right', 'up', 'down']
  const hello = { model_type: 'reve', task, class_names, model_revision: 'head-1' }
  const prediction = { task, class_names, probabilities: [.7, .1, .1, .1], model_revision: 'head-1', received_at_ms: 1000 }
  return { task, hello, prediction }
}

test('traditional SMR and gaze each accept their own frozen prediction', () => {
  for (const task of ['smr_control', 'gaze_smr']) {
    const f = fixture(task)
    assert.equal(acceptsBrainPrediction(task, f.hello, f.prediction, 1100), true)
  }
})
test('the UI-selected task cannot consume another task or mock service', () => {
  const f = fixture()
  assert.equal(acceptsBrainPrediction('gaze_smr', f.hello, f.prediction, 1100), false)
  assert.equal(acceptsBrainPrediction(f.task, { ...f.hello, model_type: 'mock' }, f.prediction, 1100), false)
  assert.equal(acceptsBrainPrediction(f.task, { ...f.hello, task: 'gaze_smr' }, f.prediction, 1100), false)
})
test('class order and explicit output semantics are checked', () => {
  const f = fixture()
  assert.equal(acceptsBrainPrediction(f.task, f.hello, { ...f.prediction, class_names: ['right_hand', 'left_hand', 'both_hand', 'rest'] }, 1100), false)
  assert.equal(acceptsBrainPrediction(f.task, f.hello, { ...f.prediction, output_semantics: 'gaze_smr_direction_4' }, 1100), false)
})
test('head switches cannot reuse a prediction from the previous revision', () => {
  const f = fixture()
  assert.equal(acceptsBrainPrediction(f.task, { ...f.hello, model_revision: 'head-2' }, f.prediction, 1100), false)
})
test('stale, pre-switch, future and non-finite timestamps are rejected', () => {
  const f = fixture()
  assert.equal(acceptsBrainPrediction(f.task, f.hello, f.prediction, 2001), false)
  assert.equal(acceptsBrainPrediction(f.task, f.hello, f.prediction, 1100, 1001), false)
  assert.equal(acceptsBrainPrediction(f.task, f.hello, f.prediction, 999), false)
  assert.equal(acceptsBrainPrediction(f.task, f.hello, { ...f.prediction, received_at_ms: NaN }, 1100), false)
})
test('malformed probabilities and unavailable handshakes fail closed', () => {
  const f = fixture()
  for (const probabilities of [[1, 0], [NaN, 0, 0, 0], [-1, 1, 1, 0], [0, 0, 0, 0]]) {
    assert.equal(acceptsBrainPrediction(f.task, f.hello, { ...f.prediction, probabilities }, 1100), false)
  }
  assert.equal(acceptsBrainPrediction(f.task, null, f.prediction, 1100), false)
})
test('unknown persisted preferences preserve the original SMR default', () => {
  assert.equal(normalizeBrainControlTask('gaze_smr'), 'gaze_smr')
  assert.equal(normalizeBrainControlTask('unknown'), 'smr_control')
  assert.equal(normalizeBrainControlTask(null), 'smr_control')
})
