import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatRecordBytes } from '../../acquisition/session/recorder'
import { SessionLogger } from '../logger'
import { useLiveEeg } from '../eeg/useLiveEeg'
import {
  canStartExperimentRecording,
  recorderBytes,
  recorderIsActive,
  rollExperimentRecording,
  startExperimentRecording,
  stopExperimentRecording,
} from '../session/recordControl'
import { sessionHub } from '../session/sessionHub'

const SUBJECT_KEY = 'passive-bci.subject-id'

export function ExportButtons({
  logger,
  subjectId,
  onSubjectChange,
  experiment,
  getSeed,
  recordControl = false,
}: {
  logger: SessionLogger
  subjectId: string
  onSubjectChange: (id: string) => void
  experiment?: string
  getSeed?: () => number | undefined
  recordControl?: boolean
}) {
  const [session, setSession] = useState(sessionHub.info)
  const [recording, setRecording] = useState(recorderIsActive)
  const [bytes, setBytes] = useState(recorderBytes)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const { live, stale, meta } = useLiveEeg()

  useEffect(() => sessionHub.subscribe(setSession), [])

  useEffect(() => {
    const id = window.setInterval(() => {
      setRecording(recorderIsActive())
      setBytes(recorderBytes())
    }, 400)
    return () => window.clearInterval(id)
  }, [])

  const changeSubject = (id: string) => {
    onSubjectChange(id)
    try {
      localStorage.setItem(SUBJECT_KEY, id)
    } catch {
      /* ignore */
    }
  }

  const metaArgs = () => ({
    experiment: experiment ?? logger.meta.experiment,
    subjectId,
    seed: getSeed?.(),
  })

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await fn()
      setMessage(result.message)
      setRecording(recorderIsActive())
      setBytes(recorderBytes())
      if (result.ok) logger.log('session_bind', { ...metaArgs(), recording: recorderIsActive() })
    } finally {
      setBusy(false)
    }
  }

  const eegColor = live ? 'var(--accent-2)' : stale ? 'var(--danger)' : 'var(--muted)'
  const eegLabel = live ? 'EEG 实时' : stale ? 'EEG 中断' : meta.link === 'open' ? 'EEG 已连接' : 'EEG 未开流'

  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-end justify-end gap-2">
        <label className="block text-sm">
          <span className="muted mb-1 block">被试编号</span>
          <input
            className="input w-28"
            value={subjectId}
            onChange={(e) => changeSubject(e.target.value)}
            placeholder="S01"
          />
        </label>
        <span className="chip self-center" style={{ color: eegColor, borderColor: `${eegColor}66` }} title={meta.detail}>
          {eegLabel}
        </span>
        {recording ? (
          <span className="chip self-center" style={{ color: 'var(--accent-2)' }} title={session.rel ?? ''}>
            录制 {formatRecordBytes(bytes)}
            {session.rel ? ` · ${session.rel.replace(/^recordings\//, '')}` : ''}
          </span>
        ) : session.active ? (
          <span className="chip self-center" title={session.rel ?? ''}>
            会话 {session.rel}
          </span>
        ) : (
          <span className="muted self-center text-xs">未写入会话库</span>
        )}
        <Link to="/recordings" className="btn self-center">
          会话库
        </Link>
      </div>

      {recordControl ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || recording || !canStartExperimentRecording()}
            onClick={() => void run(() => startExperimentRecording(metaArgs()))}
          >
            开始本局
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !recording}
            onClick={() => void run(() => stopExperimentRecording())}
          >
            结束本局
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !canStartExperimentRecording()}
            onClick={() => void run(() => rollExperimentRecording(metaArgs()))}
          >
            切新会话
          </button>
          <details className="relative">
            <summary className="btn cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              导出缓存
            </summary>
            <div className="absolute right-0 z-10 mt-1 flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg">
              <button type="button" className="btn" onClick={() => logger.download('json')}>
                JSON
              </button>
              <button type="button" className="btn" onClick={() => logger.download('csv')}>
                CSV
              </button>
            </div>
          </details>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={() => logger.download('json')}>
            导出 JSON
          </button>
          <button type="button" className="btn" onClick={() => logger.download('csv')}>
            导出 CSV
          </button>
        </div>
      )}

      {message ? <p className="muted m-0 max-w-md text-right text-xs">{message}</p> : null}
      {recordControl && !live ? (
        <p className="muted m-0 max-w-md text-right text-xs">
          先到 <Link to="/acquisition">采集页</Link> 连接并开始采集，再回来点「开始本局」。
        </p>
      ) : null}
      {recordControl && recording ? (
        <p className="muted m-0 max-w-md text-right text-xs">
          「结束本局」只停录制、不停 EEG。采集页自动开的目录若名字带 _eeg_，可点「切新会话」按被试号另存方块数据。
        </p>
      ) : null}
    </div>
  )
}

export function loadStoredSubjectId(fallback = 'S01'): string {
  try {
    return localStorage.getItem(SUBJECT_KEY)?.trim() || fallback
  } catch {
    return fallback
  }
}
