import { afterEach, expect, it, vi } from 'vitest'
import { preferredModelHead, saveModelHeadPreference, notifyModelSubjectChanged, subscribeModelHeadPreference } from './modelHeadPreference'
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
