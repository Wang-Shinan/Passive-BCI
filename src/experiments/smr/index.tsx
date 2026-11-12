import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SmrAdaptPage } from '../smr-adapt'
import { SmrGazePage } from '../smr-gaze'
import { loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { Icon } from '../../lib/ui/Icon'
import './smr.css'
import { notifyModelSubjectChanged } from '../../lib/model-runtime/modelHeadPreference'

export function SmrPage({ autoStartModel = true }: { autoStartModel?: boolean }) {
  const [params, setParams] = useSearchParams()
  const mode = params.get('mode') === 'gaze' ? 'gaze' : 'smr'
  const [subject, setSubject] = useState(() => loadStoredSubjectId('S01'))
  const [experimentBusy, setExperimentBusy] = useState(false)
  const changeSubject = (value: string) => {
    setSubject(value)
    try { localStorage.setItem('passive-bci.subject-id', value); notifyModelSubjectChanged() } catch { /* Storage may be unavailable. */ }
  }
  const selectMode = (next: 'smr' | 'gaze') => {
    if (next === mode || experimentBusy) return
    setParams({ mode: next }, { replace: true })
  }
  const shared = { embedded: true, subjectId: subject, onSubjectChange: changeSubject, onBusyChange: setExperimentBusy }
  return (
    <div className="smr-workspace">
      <header className="smr-workspace-header">
        <Link to="/" className="muted text-sm">← 实验目录</Link>
        <h1><Icon name="cursor" size={26} />SMR 采集与光标控制</h1>
        <div className="smr-mode-switch" role="group" aria-label="SMR 模式">
          <button className="btn" aria-pressed={mode === 'smr'} disabled={experimentBusy} onClick={() => selectMode('smr')}><Icon name="cursor" size={18} />普通 SMR</button>
          <button className="btn" aria-pressed={mode === 'gaze'} disabled={experimentBusy} onClick={() => selectMode('gaze')}><Icon name="focus" size={18} />全屏 SMR</button>
        </div>
        <p className="muted smr-mode-note" role="status">{experimentBusy
          ? '当前实验结束后可切换模式。'
          : '切换模式后配置当前任务；两种模式分别保存录制和使用对应模型。'}</p>
      </header>
      {mode === 'smr'
        ? <SmrAdaptPage {...shared} autoStartModel={autoStartModel} />
        : <SmrGazePage {...shared} />}
    </div>
  )
}
