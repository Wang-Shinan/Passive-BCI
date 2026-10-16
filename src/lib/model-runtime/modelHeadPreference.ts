import { defaultSubjectHead } from './subjectModels'
const KEY = 'passive-bci.model-heads'
const SUBJECT_KEY = 'passive-bci.subject-id'
const SUBJECT_HEADS_KEY = 'passive-bci.subject-model-heads.v1'
const listeners = new Set<() => void>()
export function currentModelSubject(): string {
  try { return localStorage.getItem(SUBJECT_KEY)?.trim() || 'S01' } catch { return 'S01' }
}
export function notifyModelSubjectChanged(): void { for (const fn of listeners) fn() }
function preferenceKey(task: string, subjectId: string): string { return JSON.stringify([subjectId.trim(), task]) }
export function preferredModelHead(task = 'passive_rating', subjectId = currentModelSubject()): string {
  try {
    const scoped = task === 'smr_control'
    const value = JSON.parse(localStorage.getItem(scoped ? SUBJECT_HEADS_KEY : KEY) || '{}')?.[scoped ? preferenceKey(task, subjectId) : task]
    return typeof value === 'string' ? value : defaultSubjectHead(task, subjectId)
  } catch { return '' }
}
export function saveModelHeadPreference(task: string, id: string, subjectId = currentModelSubject()): void {
  const scoped = task === 'smr_control'
  const key = scoped ? SUBJECT_HEADS_KEY : KEY
  let previous: Record<string, string> = {}
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) previous = value
    localStorage.setItem(key, JSON.stringify({ ...previous, [scoped ? preferenceKey(task, subjectId) : task]: id }))
  } catch { throw new Error('无法保存模型选择，请检查浏览器存储权限') }
  notifyModelSubjectChanged()
}
export function subscribeModelHeadPreference(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if ([KEY, SUBJECT_KEY, SUBJECT_HEADS_KEY, null].includes(event.key)) notifyModelSubjectChanged()
})
