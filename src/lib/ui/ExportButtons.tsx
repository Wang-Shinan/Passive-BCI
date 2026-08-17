import { useEffect, useState } from 'react'
import { SessionLogger } from '../logger'
import { sessionHub } from '../session/sessionHub'

export function ExportButtons({ logger, subjectId, onSubjectChange }: {
  logger: SessionLogger
  subjectId: string
  onSubjectChange: (id: string) => void
}) {
  const [session, setSession] = useState(sessionHub.info)
  useEffect(() => sessionHub.subscribe(setSession), [])

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block text-sm">
        <span className="muted mb-1 block">被试编号</span>
        <input
          className="input w-28"
          value={subjectId}
          onChange={(e) => onSubjectChange(e.target.value)}
          placeholder="S01"
        />
      </label>
      {session.active ? (
        <span className="chip self-center" style={{ color: 'var(--accent-2)' }} title={session.rel ?? ''}>
          会话 {session.rel}
        </span>
      ) : (
        <span className="muted self-center text-xs">未挂接 EEG 会话，事件仅在浏览器</span>
      )}
      <button type="button" className="btn" onClick={() => logger.download('json')}>
        导出 JSON
      </button>
      <button type="button" className="btn" onClick={() => logger.download('csv')}>
        导出 CSV
      </button>
    </div>
  )
}
