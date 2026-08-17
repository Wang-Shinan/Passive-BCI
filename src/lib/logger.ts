import { sampleClock } from './eeg/sampleClock'
import { CONTEXT_SCHEMA, EVENT_SCHEMA, type SessionContextRecord } from './session/contracts'
import { sessionHub } from './session/sessionHub'

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

const EVENT_RING = 2000
const CONTEXT_RING = 6000

/**
 * Timestamped event stream. When an EEG session is on disk, lines go to
 * events.jsonl / context.jsonl and RAM only keeps a short ring.
 */
export class SessionLogger {
  readonly meta: SessionMeta
  private events: LogEvent[] = []
  private contexts: Record<string, unknown>[] = []
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
    if (sessionHub.active) {
      sessionHub.bindMeta({ experiment: this.meta.experiment, subjectId })
    }
  }

  log(type: string, data?: Record<string, unknown>): void {
    const eeg = sampleClock.snapshot()
    const t = performance.now() - this.t0
    const perf_ms = performance.now()
    this.events.push({
      t,
      experiment: this.meta.experiment,
      type,
      data: eeg ? { ...data, eeg } : data,
    })
    if (sessionHub.active && this.events.length > EVENT_RING) {
      this.events = this.events.slice(-EVENT_RING)
    }
    sessionHub.logEvent({
      schema: EVENT_SCHEMA,
      t_ms: t,
      perf_ms,
      experiment: this.meta.experiment,
      subjectId: this.meta.subjectId,
      type,
      data,
      eeg,
    })
  }

  logContext(row: object): void {
    const eeg = sampleClock.snapshot()
    const t = performance.now() - this.t0
    const perf_ms = performance.now()
    const record: SessionContextRecord = {
      schema: CONTEXT_SCHEMA,
      t_ms: t,
      perf_ms,
      experiment: this.meta.experiment,
      subjectId: this.meta.subjectId,
      eeg,
      ...(row as Record<string, unknown>),
    }
    if (!sessionHub.active) {
      this.contexts.push(record)
      if (this.contexts.length > CONTEXT_RING) {
        this.contexts = this.contexts.slice(-Math.floor(CONTEXT_RING / 2))
      }
    }
    sessionHub.logContext(record)
  }

  getEvents(): readonly LogEvent[] {
    return this.events
  }

  clear(): void {
    this.events = []
    this.contexts = []
    this.t0 = performance.now()
    this.meta.startedAt = new Date().toISOString()
  }

  toJSON(): string {
    return JSON.stringify(
      {
        meta: this.meta,
        events: this.events,
        context: this.contexts,
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
