import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Panel } from '../lib/ui/Panel'
import { fetchSessionList, type SessionSummary } from '../recordings/api'
import { fetchModelHeads, type ModelHeadOption } from '../lib/model-runtime/modelServiceApi'
import { HeadSelector } from '../lib/model-runtime/HeadSelector'

type Job = { id: string; kind: 'export' | 'fit'; status: string; startedAt: string; error?: string; config: Record<string, unknown> }
type Report = { shape?: number[]; classNames?: string[]; counts?: number[]; headId?: string; splitBy?: string
  metrics?: Record<string, { count: number; accuracy: number; balancedAccuracy: number; confusion: number[][] }> }
type Detail = { job: Job; log: string; report: Report | null }
async function api<T>(url: string, body?: object): Promise<T> {
  const response = await fetch('/api/training/' + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const data = await response.json()
  if (!response.ok || !data.ok) throw new Error(data.message || '训练接口不可用')
  return data as T
}
const STATUS: Record<string, string> = { running: '运行中', complete: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }

export function TrainingPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [heads, setHeads] = useState<ModelHeadOption[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [selectedJob, setSelectedJob] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [datasetId, setDatasetId] = useState('')
  const [headId, setHeadId] = useState('')
  const [subjectId, setSubjectId] = useState(1)
  const [labelSource, setLabelSource] = useState('trial')
  const [epochs, setEpochs] = useState(400)
  const [lr, setLr] = useState(.02)
  const [seed, setSeed] = useState(0)
  const [splitBy, setSplitBy] = useState('session')
  const [device, setDevice] = useState('cpu')
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    const result = await api<{ jobs: Job[]; busy: boolean }>('jobs')
    setJobs(result.jobs); setBusy(result.busy)
  }, [])
  const refreshSources = async () => {
    try {
      setSessions(await fetchSessionList())
      setHeads(await fetchModelHeads())
    } catch (e) { setError(String(e)) }
  }
  useEffect(() => { void refreshSources() }, [])
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        await refresh()
        if (selectedJob) {
          const value = await api<Detail>('jobs/' + selectedJob)
          if (!stopped) setDetail(value)
        }
      } catch (e) { if (!stopped) setError(String(e)) }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [refresh, selectedJob])
  const start = async (kind: 'export' | 'fit') => {
    setSubmitting(true); setError(''); setMessage('')
    try {
      const data = await api<{ job: Job }>('jobs', kind === 'export'
        ? { kind, sessions: selected, labelSource, subjectId }
        : { kind, datasetId, headId, epochs, lr, seed, splitBy, device })
      setSelectedJob(data.job.id); setDetail(null); await refresh()
    } catch (e) { setError(String(e)) }
    finally { setSubmitting(false) }
  }
  const cancel = async () => {
    setSubmitting(true)
    try { await api(`jobs/${selectedJob}/cancel`, {}); await refresh() }
    catch (e) { setError(String(e)) }
    finally { setSubmitting(false) }
  }
  const artifact = (name: string) => `/api/training/jobs/${selectedJob}/${name}`
  const locked = busy || submitting
  return <main className="mx-auto max-w-7xl px-6 py-8">
    <Link className="muted text-sm" to="/">← 返回首页</Link>
    <h1 className="text-2xl font-semibold">数据导出与 Linear Probing</h1>
    <p className="muted text-sm">SMR 四类：录制数据 → H5 → 冻结 REVE、训练线性头 → 评估 → 在模型面板应用。任务在后台运行，离开本页后可回来查看。</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {message && <p role="status">{message}</p>}
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="1 · 导出 H5" actions={<button className="btn" onClick={() => void refreshSources()}>刷新数据</button>}>
        <p className="muted text-xs">仅选择同一被试、相同通道与采样率的 SMR 录制。无 EEG 的 N-back 行为会话不能作为 EEG 训练数据。</p>
        <div className="max-h-64 space-y-2 overflow-auto">
          {sessions.map(session => {
            const eligible = session.eegBytes > 0 && session.events > 0 && session.status === 'complete'
            return <label key={session.stem} className="flex items-start gap-2 text-sm">
              <input type="checkbox" disabled={!eligible || locked} checked={selected.includes(session.stem)} onChange={event => setSelected(event.target.checked ? [...selected, session.stem] : selected.filter(s => s !== session.stem))} />
              <span className="break-all">{session.stem}<span className="muted block text-xs">{session.subjectId || '未标被试'} · {session.experiment || '未标任务'} · {session.events} 个事件{!eligible ? ' · 无完整 EEG/事件，不可导出' : ''}</span></span>
            </label>
          })}
          {!sessions.length && <p className="muted text-sm">暂无录制数据，请先到采集页录制。</p>}
        </div>
        <div className="my-4 flex flex-wrap gap-3">
          <label className="grid gap-1 text-sm">H5 被试数字编号<input className="input" type="number" min={1} value={subjectId} disabled={locked} onChange={e => setSubjectId(Number(e.target.value))} /></label>
          <label className="grid gap-1 text-sm">标签来源<select className="select" value={labelSource} disabled={locked} onChange={e => setLabelSource(e.target.value)}><option value="trial">SMR 试次标签</option><option value="auto">自动识别标签事件</option></select></label>
        </div>
        <p className="muted text-xs">固定 2 秒窗口、2 秒步长；丢弃不足整窗的数据。保留原始会话和试次编号，供训练时分组。</p>
        <button className="btn btn-primary" disabled={locked || !selected.length} onClick={() => void start('export')}>导出选中的 {selected.length} 个会话</button>
      </Panel>
      <Panel title="2 · 训练线性头">
        <fieldset disabled={locked} className="grid gap-3 border-0 p-0">
          <label className="grid gap-1 text-sm">H5 数据集<select className="select" value={datasetId} onChange={e => setDatasetId(e.target.value)}><option value="">请选择已完成的导出</option>{jobs.filter(j => j.kind === 'export' && j.status === 'complete').map(j => <option key={j.id} value={j.id}>{new Date(j.startedAt).toLocaleString()} · {j.id.slice(0, 8)}</option>)}</select></label>
          <HeadSelector heads={heads} task="smr_control" value={headId} onChange={setHeadId} disabled={locked} label="冻结编码器" defaultLabel="REVE base（无 LoRA）" />
          <p className="muted m-0 text-xs">只训练新的线性层；所选文件仅用于确定编码器，旧线性头不会被覆盖。</p>
          <div className="grid grid-cols-3 gap-2">
            <label className="grid gap-1 text-sm">Epochs<input className="input w-full" type="number" min={1} max={5000} value={epochs} onChange={e => setEpochs(Number(e.target.value))} /></label>
            <label className="grid gap-1 text-sm">学习率<input className="input w-full" type="number" min={.000001} max={1} step={.001} value={lr} onChange={e => setLr(Number(e.target.value))} /></label>
            <label className="grid gap-1 text-sm">随机种子<input className="input w-full" type="number" min={0} value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
          </div>
          <label className="grid gap-1 text-sm">训练 / 验证 / 测试分组（约 60 / 20 / 20）<select className="select" value={splitBy} onChange={e => setSplitBy(e.target.value)}><option value="session">按会话隔离（至少 3 个会话）</option><option value="trial">按原始试次隔离（同一会话可分组）</option></select></label>
          <label className="grid gap-1 text-sm">计算设备<select className="select" value={device} onChange={e => setDevice(e.target.value)}><option value="cpu">CPU</option><option value="cuda">GPU / CUDA</option><option value="auto">自动</option></select></label>
          <p className="muted m-0 text-xs">同一组不会跨集合；三组都必须覆盖四个类别，否则提示补充数据。GPU 训练会与实时模型竞争资源。</p>
          <button className="btn btn-primary" disabled={!datasetId || locked} onClick={() => void start('fit')}>开始 Linear Probing</button>
        </fieldset>
      </Panel>
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_2fr]">
      <Panel title="任务历史">
        <div className="max-h-96 space-y-2 overflow-auto">{jobs.map(job => <button key={job.id} className="btn block w-full text-left" onClick={() => { setSelectedJob(job.id); setDetail(null) }}>{job.kind === 'export' ? 'H5 导出' : 'Linear probing'} · {STATUS[job.status]}<span className="muted block text-xs">{new Date(job.startedAt).toLocaleString()} · {job.id.slice(0, 8)}</span></button>)}</div>
      </Panel>
      <Panel title="日志与结果">
        {!detail ? <p className="muted">选择任务查看。</p> : <>
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="chip">{STATUS[detail.job.status]}</span>
            {detail.job.status === 'running' && <button className="btn" disabled={submitting} onClick={() => void cancel()}>取消任务</button>}
            <a className="btn" href={artifact('log.txt')}>下载日志</a>
            {detail.job.status === 'complete' && <><a className="btn" href={artifact('report.json')}>下载报告</a><a className="btn" href={artifact(detail.job.kind === 'export' ? 'dataset.h5' : 'head.pt')}>下载{detail.job.kind === 'export' ? ' H5' : '线性头'}</a></>}
          </div>
          {detail.job.error && <p className="text-red-400">{detail.job.error}</p>}
          {detail.report?.shape && <p>H5 形状：{detail.report.shape.join(' × ')}（窗口 × 通道 × 采样点）</p>}
          {detail.report?.counts && <p>各类窗口数：{detail.report.classNames?.map((name, i) => `${name}: ${detail.report!.counts![i]}`).join(' · ')}</p>}
          {detail.report?.metrics && <div className="grid gap-3 sm:grid-cols-3">{Object.entries(detail.report.metrics).map(([name, metric]) => <div className="panel p-3" key={name}><strong>{name}</strong><p>{metric.count} 个窗口</p><p>正确率 {(metric.accuracy * 100).toFixed(1)}%</p><p>平衡正确率 {(metric.balancedAccuracy * 100).toFixed(1)}%</p></div>)}</div>}
          {detail.report?.headId && <div className="my-3"><p className="break-all">已生成：{detail.report.headId}</p><button className="btn" onClick={() => {
            try {
              const saved = JSON.parse(localStorage.getItem('passive-bci.model-heads') || '{}')
              localStorage.setItem('passive-bci.model-heads', JSON.stringify({ ...saved, smr_control: detail.report!.headId }))
              setMessage('已设为待选线性头。前往模型面板，点击启动按钮应用。')
            } catch { setError('无法保存选择，请到模型面板手动选择该文件') }
          }}>设为待选线性头</button> <Link className="btn" to="/smr-adapt">前往模型面板</Link></div>}
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 p-3 text-xs">{detail.log || '等待进程日志…'}</pre>
        </>}
      </Panel>
    </div>
  </main>
}
