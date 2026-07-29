export interface LogEvent {
  t: number
  experiment: string
  type: string
  data?: Record<string, unknown>
}

export interface SessionMeta {
  subjectId: string
  experiment: string
  startedAt: string
}

/**
 * Timestamped event stream with JSON / CSV export.
 */
export class SessionLogger {
  readonly meta: SessionMeta
  private events: LogEvent[] = []
  private t0: number

  constructor(experiment: string, subjectId = 'anon') {
    this.meta = {
      subjectId,
      experiment,
      startedAt: new Date().toISOString(),
    }
    this.t0 = performance.now()
  }

  setSubjectId(subjectId: string): void {
    this.meta.subjectId = subjectId
  }

  log(type: string, data?: Record<string, unknown>): void {
    this.events.push({
      t: performance.now() - this.t0,
      experiment: this.meta.experiment,
      type,
      data,
    })
  }

  getEvents(): readonly LogEvent[] {
    return this.events
  }

  clear(): void {
    this.events = []
    this.t0 = performance.now()
    this.meta.startedAt = new Date().toISOString()
  }

  toJSON(): string {
    return JSON.stringify(
      {
        meta: this.meta,
        events: this.events,
      },
      null,
      2,
    )
  }

  toCSV(): string {
    const rows = ['t_ms,experiment,type,data_json']
    for (const e of this.events) {
      const data = e.data ? JSON.stringify(e.data).replaceAll('"', '""') : ''
      rows.push(`${e.t.toFixed(3)},${e.experiment},${e.type},"${data}"`)
    }
    return rows.join('\n')
  }

  download(format: 'json' | 'csv' = 'json'): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${this.meta.experiment}_${this.meta.subjectId}_${stamp}.${format}`
    const content = format === 'json' ? this.toJSON() : this.toCSV()
    const mime = format === 'json' ? 'application/json' : 'text/csv'
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
}
