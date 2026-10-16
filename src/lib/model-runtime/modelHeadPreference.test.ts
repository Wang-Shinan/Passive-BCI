import { afterEach, expect, it, vi } from 'vitest'
import { preferredModelHead, saveModelHeadPreference, notifyModelSubjectChanged, subscribeModelHeadPreference } from './modelHeadPreference'
import { S04_HEAD } from './subjectModels'

it('defaults S04 to the imported individual model but preserves explicit choices and other subjects', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  expect(preferredModelHead('smr_control', 'S04')).toBe(S04_HEAD)
  expect(preferredModelHead('smr_control', 'S05')).toBe('')
  saveModelHeadPreference('smr_control', 'new-trained.pt', 'S04')
  expect(preferredModelHead('smr_control', 'S04')).toBe('new-trained.pt')
  saveModelHeadPreference('smr_control', '', 'S04')
  expect(preferredModelHead('smr_control', 'S04')).toBe('')
})
it.each(['smr_control_s04_reve_20261015_baseline.pt', 'smr_control_s04_joint_20261016.pt'])('preserves explicitly selected historical S04 head %s', previousHead => {
  const values = new Map<string, string>([['passive-bci.subject-model-heads.v1', JSON.stringify({
    '["S04","smr_control"]': previousHead,
  })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  expect(preferredModelHead('smr_control', 'S04')).toBe(previousHead)
  expect(S04_HEAD).toBe('smr_control_lp_093f1a91-f720-4773-b87f-4c2f8a5daea3.pt')
})
afterEach(() => vi.unstubAllGlobals())

it('isolates SMR heads by subject, preserving each subject selection and an explicit embedded default', () => {
  const values = new Map<string, string>([['passive-bci.model-heads', JSON.stringify({ smr_control: 'legacy-global.pt', gaze_smr: 'gaze.pt' })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  values.set('passive-bci.subject-id', 'S01')
  expect(preferredModelHead('smr_control')).toBe('')
  saveModelHeadPreference('smr_control', 's01-trained.pt')
  values.set('passive-bci.subject-id', 'S02')
  expect(preferredModelHead('smr_control')).toBe('')
  saveModelHeadPreference('smr_control', 's02-trained.pt')
  values.set('passive-bci.subject-id', 'S01')
  expect(preferredModelHead('smr_control')).toBe('s01-trained.pt')
  saveModelHeadPreference('smr_control', '')
  expect(preferredModelHead('smr_control')).toBe('')
  expect(preferredModelHead('smr_control', 'S02')).toBe('s02-trained.pt')
  expect(preferredModelHead('gaze_smr')).toBe('gaze.pt')
})
it('notifies mounted model pickers when the subject changes in this tab', () => {
  const listener = vi.fn(), unsubscribe = subscribeModelHeadPreference(listener)
  notifyModelSubjectChanged()
  expect(listener).toHaveBeenCalledTimes(1)
  unsubscribe()
})
