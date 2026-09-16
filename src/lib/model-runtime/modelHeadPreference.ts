const KEY = 'passive-bci.model-heads'
const listeners = new Set<() => void>()
export function preferredModelHead(task = 'passive_rating'): string {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')?.[task]
    return typeof value === 'string' ? value : ''
  } catch { return '' }
}
export function saveModelHeadPreference(task: string, id: string): void {
  let previous: Record<string, string> = {}
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) previous = value
    localStorage.setItem(KEY, JSON.stringify({ ...previous, [task]: id }))
  } catch { throw new Error('无法保存模型选择，请检查浏览器存储权限') }
  for (const fn of listeners) fn()
}
export function subscribeModelHeadPreference(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) for (const fn of listeners) fn()
})
