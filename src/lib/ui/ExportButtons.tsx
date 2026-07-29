import { SessionLogger } from '../logger'

export function ExportButtons({ logger, subjectId, onSubjectChange }: {
  logger: SessionLogger
  subjectId: string
  onSubjectChange: (id: string) => void
}) {
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
      <button type="button" className="btn" onClick={() => logger.download('json')}>
        导出 JSON
      </button>
      <button type="button" className="btn" onClick={() => logger.download('csv')}>
        导出 CSV
      </button>
    </div>
  )
}
