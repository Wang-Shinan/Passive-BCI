import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatRecordBytes } from '../acquisition/session/recorder'
import {
  deleteSession,
  fetchSessionList,
  fetchSessionPreview,
  patchSessionMeta,
  sessionZipUrl,
  type SessionPreview,
  type SessionStatus,
  type SessionSummary,
} from './api'

const EXPERIMENT_LABEL: Record<string, string> = {
  tetris: '俄罗斯方块',
  'rl-graph': '人脑反馈强化学习',
  'card-cit': '扑克牌 CIT',
  jump: '跳一跳',
  'draw-guess': '你画我猜',
  dino: '小恐龙',
  schulte: '舒尔特方格',
}

const DEVICE_LABEL: Record<string, string> = {
  omni: 'OmniBCI',
  neuracle: '博睿康',
  bcigo: '强脑 BCIGo',
}

function experimentLabel(id: string | null): string {
  if (!id) return '未标注'
  return EXPERIMENT_LABEL[id] ?? id
}

function deviceLabel(id: string | null): string {
  if (!id) return '—'
  return DEVICE_LABEL[id] ?? id
}

function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${m}:${String(r).padStart(2, '0')}`
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusMeta(status: SessionStatus): { label: string; color: string } {
  if (status === 'recording') return { label: '录制中', color: 'var(--accent-2)' }
  if (status === 'interrupted') return { label: '异常中断', color: 'var(--warn)' }
  if (status === 'empty') return { label: '空', color: 'var(--muted)' }
  return { label: '已完成', color: 'var(--accent)' }
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())))]
}

export function RecordingsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<SessionPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [experiment, setExperiment] = useState('all')
  const [subject, setSubject] = useState('all')
  const [status, setStatus] = useState('all')

  const load = useCallback(async () => {
    setError(null)
    try {
      const list = await fetchSessionList()
      setSessions(list)
      setSelected((cur) => {
        if (cur && list.some((s) => s.stem === cur)) return cur
        return list[0]?.stem ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => {
    if (!selected) {
      setPreview(null)
      setNotes('')
      return
    }
    const row = sessions.find((s) => s.stem === selected)
    setNotes(row?.notes ?? '')
    let cancelled = false
    setPreviewError(null)
    void fetchSessionPreview(selected)
      .then((body) => {
        if (!cancelled) setPreview(body)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreview(null)
          setPreviewError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [selected, sessions])

  const experiments = useMemo(() => unique(sessions.map((s) => s.experiment)), [sessions])
  const subjects = useMemo(() => unique(sessions.map((s) => s.subjectId)), [sessions])

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    return sessions.filter((s) => {
      if (experiment !== 'all' && s.experiment !== experiment) return false
      if (subject !== 'all' && s.subjectId !== subject) return false
      if (status !== 'all' && s.status !== status) return false
      if (!query) return true
      const hay = [s.stem, s.subjectId, s.experiment, s.notes, s.device, s.rel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(query)
    })
  }, [sessions, q, experiment, subject, status])

  const current = sessions.find((s) => s.stem === selected) ?? null

  const saveNotes = async () => {
    if (!current) return
    setSavingNotes(true)
    setError(null)
    try {
      const next = await patchSessionMeta(current.stem, { notes })
      setSessions((list) => list.map((s) => (s.stem === next.stem ? { ...s, ...next } : s)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingNotes(false)
    }
  }

  const remove = async () => {
    if (!current || current.live) return
    if (!window.confirm(`删除会话 ${current.stem}？此操作不能恢复。`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteSession(current.stem)
      setSelected(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-1 text-2xl font-semibold">会话库</h1>
          <p className="muted m-0 mt-1 max-w-2xl text-sm">
            每个目录是一局：EEG（eeg.bin）+ 游戏事件 + 棋盘快照。采俄罗斯方块时，先在采集页开流，再进方块页点「开始本局」。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/acquisition" className="btn">
            采集页
          </Link>
          <Link to="/tetris" className="btn btn-primary">
            去方块实验
          </Link>
          <button type="button" className="btn" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </header>

      {error ? (
        <p className="mb-4 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
          {error.includes('Failed') || error.includes('fetch')
            ? '（会话库只在 npm run dev 下可用）'
            : ''}
        </p>
      ) : null}

      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <label className="block text-sm md:col-span-1">
          <span className="muted mb-1 block">搜索</span>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="被试 / 目录名 / 备注" />
        </label>
        <label className="block text-sm">
          <span className="muted mb-1 block">实验</span>
          <select className="select" value={experiment} onChange={(e) => setExperiment(e.target.value)}>
            <option value="all">全部</option>
            {experiments.map((id) => (
              <option key={id} value={id}>
                {experimentLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="muted mb-1 block">被试</span>
          <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="all">全部</option>
            {subjects.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="muted mb-1 block">状态</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">全部</option>
            <option value="recording">录制中</option>
            <option value="complete">已完成</option>
            <option value="interrupted">异常中断</option>
          </select>
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <h2 className="m-0 text-sm font-semibold">
              {loading ? '读取中…' : `${filtered.length} 个会话`}
            </h2>
            <span className="muted text-xs">recordings/</span>
          </div>
          <div className="max-h-[70vh] overflow-auto">
            {filtered.length === 0 && !loading ? (
              <p className="muted px-4 py-8 text-sm">还没有会话。开流后在方块页点「开始本局」。 </p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-[var(--panel)] text-xs text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium">被试</th>
                    <th className="px-3 py-2 font-medium">实验</th>
                    <th className="px-3 py-2 font-medium">时长</th>
                    <th className="px-3 py-2 font-medium">EEG</th>
                    <th className="px-3 py-2 font-medium">事件</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const st = statusMeta(s.status)
                    const active = s.stem === selected
                    return (
                      <tr
                        key={s.stem}
                        className="cursor-pointer border-t border-[var(--border)]"
                        style={{ background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined }}
                        onClick={() => setSelected(s.stem)}
                      >
                        <td className="px-3 py-2">
                          <span className="chip" style={{ color: st.color, borderColor: `${st.color}66` }}>
                            {st.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatWhen(s.startedAt)}</td>
                        <td className="px-3 py-2">{s.subjectId || '—'}</td>
                        <td className="px-3 py-2">{experimentLabel(s.experiment)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDuration(s.durationSec)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatRecordBytes(s.eegBytes)}</td>
                        <td className="px-3 py-2 tabular-nums">{s.events}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <aside className="panel p-4">
          {!current ? (
            <p className="muted m-0 text-sm">选择左侧一条会话查看详情。</p>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span
                    className="chip"
                    style={{
                      color: statusMeta(current.status).color,
                      borderColor: `${statusMeta(current.status).color}66`,
                    }}
                  >
                    {statusMeta(current.status).label}
                  </span>
                  <span className="muted text-xs">{current.rel}</span>
                </div>
                <h2 className="m-0 text-lg font-semibold">{current.stem}</h2>
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="muted text-xs">被试</dt>
                  <dd className="m-0">{current.subjectId || '—'}</dd>
                </div>
                <div>
                  <dt className="muted text-xs">实验</dt>
                  <dd className="m-0">{experimentLabel(current.experiment)}</dd>
                </div>
                <div>
                  <dt className="muted text-xs">设备</dt>
                  <dd className="m-0">
                    {deviceLabel(current.device)}
                    {current.channels ? ` · ${current.channels} 导` : ''}
                    {current.sampleRate ? ` @ ${current.sampleRate} Hz` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="muted text-xs">时长 / 体积</dt>
                  <dd className="m-0">
                    {formatDuration(current.durationSec)} · {formatRecordBytes(current.bytes)}
                  </dd>
                </div>
                <div>
                  <dt className="muted text-xs">事件 / 快照</dt>
                  <dd className="m-0">
                    {current.events} / {current.contexts}
                  </dd>
                </div>
                <div>
                  <dt className="muted text-xs">种子</dt>
                  <dd className="m-0">
                    {typeof current.game?.seed === 'number' ? String(current.game.seed) : '—'}
                  </dd>
                </div>
              </dl>

              {Object.keys(current.eventTypes).length ? (
                <div>
                  <div className="muted mb-1 text-xs">事件类型</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(current.eventTypes)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 10)
                      .map(([type, n]) => (
                        <span key={type} className="chip text-xs">
                          {type} {n}
                        </span>
                      ))}
                  </div>
                </div>
              ) : null}

              <label className="block text-sm">
                <span className="muted mb-1 block">备注（block / 指导语 / 异常）</span>
                <textarea
                  className="input min-h-24 resize-y"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="例如：第 1 局，闭眼校准后开始；中途摘过一次耳机"
                />
              </label>
              <button type="button" className="btn" disabled={savingNotes} onClick={() => void saveNotes()}>
                {savingNotes ? '保存中…' : '保存备注'}
              </button>

              <div>
                <div className="muted mb-1 text-xs">文件</div>
                <ul className="m-0 list-none space-y-1 p-0 text-sm">
                  {current.files.map((f) => (
                    <li key={f.name} className="flex justify-between gap-3">
                      <span>{f.name}</span>
                      <span className="muted tabular-nums">{formatRecordBytes(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {previewError ? (
                <p className="m-0 text-xs" style={{ color: 'var(--danger)' }}>
                  {previewError}
                </p>
              ) : preview?.events.length ? (
                <div>
                  <div className="muted mb-1 text-xs">最近事件</div>
                  <ol className="m-0 max-h-40 list-none space-y-1 overflow-auto p-0 font-mono text-[11px] leading-snug">
                    {preview.events.map((ev, i) => {
                      const row = ev as { type?: string; t_ms?: number }
                      return (
                        <li key={i} className="muted">
                          {typeof row.t_ms === 'number' ? `${(row.t_ms / 1000).toFixed(1)}s ` : ''}
                          {row.type ?? JSON.stringify(ev).slice(0, 80)}
                        </li>
                      )
                    })}
                  </ol>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {current.live ? (
                  <span className="muted self-center text-xs">录制中无法打包或删除</span>
                ) : (
                  <>
                    <a className="btn btn-primary" href={sessionZipUrl(current.stem)}>
                      下载 ZIP
                    </a>
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
