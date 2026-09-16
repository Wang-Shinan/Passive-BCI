import { useEffect, useState } from 'react'
import { HeadSelector } from './HeadSelector'
import { fetchModelHeads, selectModelHeadPreference, type ModelHeadOption } from './modelServiceApi'
import { useModelConfiguration } from './useModelConfiguration'

export function ModelHeadPicker({ task, disabled = false }: { task: string; disabled?: boolean }) {
  const { headId, locked } = useModelConfiguration(task)
  const [heads, setHeads] = useState<ModelHeadOption[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const refresh = async (signal?: AbortSignal) => {
    setLoading(true); setError('')
    try { setHeads(await fetchModelHeads(signal)) }
    catch (e) { if (!signal?.aborted) setError(String(e)) }
    finally { if (!signal?.aborted) setLoading(false) }
  }
  useEffect(() => { const c = new AbortController(); void refresh(c.signal); return () => c.abort() }, [])
  return <div className="space-y-2">
    <HeadSelector heads={heads} task={task} value={headId} disabled={disabled || locked || loading}
      defaultLabel={task === 'gaze_smr' ? '当前激活 gaze 头及其报告' : '默认配置'}
      onChange={id => { try { selectModelHeadPreference(task, id); setError('') } catch (e) { setError(String(e)) } }} />
    <button className="btn" disabled={disabled || locked || loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新线性头'}</button>
    {error && <p role="alert" className="text-sm">{error}</p>}
  </div>
}
