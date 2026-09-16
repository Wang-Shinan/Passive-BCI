import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { generateTrials, scoreTrial, summarize, type Result, type Trial } from './engine'
import { saveNBack, retryNBackSaves } from './storage'
import { sessionHub } from '../../lib/session/sessionHub'

type Config = { n: number; count: number; stimulusMs: number; intervalMs: number }
type Run = { config: Config; trials: Trial[]; seed: number; id: string; subjectId: string; startedAt: string }
const OUTCOMES = { warmup: '记忆阶段', hit: '命中', miss: '漏报', false_alarm: '误报', correct_rejection: '正确拒绝' }

export function NBackExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [config, setConfig] = useState<Config>({ n: 2, count: 40, stimulusMs: 500, intervalMs: 2000 })
  const [run, setRun] = useState<Run | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'stopped'>('idle')
  const [index, setIndex] = useState(-1)
  const [visible, setVisible] = useState(false)
  const [responded, setResponded] = useState(false)
  const [results, setResults] = useState<Result[]>([])
  const [notice, setNotice] = useState('')
  const [saveMessage, setSaveMessage] = useState('每轮自动保存行为数据，无需连接 EEG。')
  const logger = useRef(new SessionLogger('nback', subjectId))
  const response = useRef<() => void>(() => {})
  const abort = useRef<(reason: string) => void>(() => {})
  const summary = summarize(results)
  const running = status === 'running'

  useEffect(() => { logger.current.setSubjectId(subjectId) }, [subjectId])
  useEffect(() => { retryNBackSaves(setSaveMessage) }, [])

  useEffect(() => {
    if (!run) return
    const log = logger.current
    const events: ReturnType<SessionLogger['getEvents']>[number][] = []
    const record = (type: string, data: Record<string, unknown>) => {
      log.log(type, { ...data, blockId: run.id, blockSubjectId: run.subjectId })
      events.push(log.getEvents().at(-1)!)
    }
    let revision = 0
    let ended = false
    let current = -1
    let onset = 0
    let rt: number | null = null
    let frame = 0
    let hideTimer = 0
    let nextTimer = 0
    const completed: Result[] = []
    const persist = (saveStatus: 'running' | 'complete' | 'interrupted', reason: string) => {
      saveNBack({ ...run, revision: revision++, updatedAt: new Date().toISOString(),
        status: saveStatus, reason, results: [...completed], events: [...events],
        eegSessionRel: sessionHub.info.rel,
      }, setSaveMessage)
    }
    const clearTimers = () => {
      cancelAnimationFrame(frame)
      clearTimeout(hideTimer)
      clearTimeout(nextTimer)
    }
    const finish = (reason: string) => {
      if (ended) return
      ended = true
      clearTimers()
      record(reason === 'complete' ? 'block_end' : 'block_abort', {
        reason, seed: run.seed, config: run.config, ...summarize(completed),
        interruptedTrial: reason === 'complete' ? null : current,
      })
      persist(reason === 'complete' ? 'complete' : 'interrupted', reason)
      setVisible(false)
      setStatus(reason === 'complete' ? 'done' : 'stopped')
      setNotice(reason === 'complete' ? '本轮完成，可导出结果或开始新一轮。' : '本轮已中止；未完成试次不计分，已完成结果可导出。')
    }
    abort.current = finish
    response.current = () => {
      const now = performance.now()
      if (ended || current < 0 || rt !== null || now >= onset + run.config.intervalMs) return
      rt = now - onset
      setResponded(true)
      record('response', { index: current, rtMs: rt, scored: run.trials[current]!.scored, input: 'match' })
    }
    const present = () => {
      frame = requestAnimationFrame(() => {
        if (ended) return
        current++
        rt = null
        onset = performance.now()
        setIndex(current)
        setVisible(true)
        setResponded(false)
        record('stimulus_onset', { index: current, ...run.trials[current], n: run.config.n, onsetPerfMs: onset })
        hideTimer = window.setTimeout(() => {
          setVisible(false)
          record('stimulus_offset', { index: current, actualDurationMs: performance.now() - onset })
        }, run.config.stimulusMs)
        nextTimer = window.setTimeout(() => {
          const result = scoreTrial(run.trials[current]!, current, rt)
          completed.push(result)
          setResults([...completed])
          record('trial_end', { ...result, actualIntervalMs: performance.now() - onset })
          if (current + 1 === run.trials.length) finish('complete')
          else { persist('running', 'checkpoint'); present() }
        }, run.config.intervalMs)
      })
    }
    const key = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.target instanceof HTMLElement && event.target.closest('input,select,textarea,button,a,[contenteditable="true"]')) return
      event.preventDefault()
      response.current()
    }
    const hidden = () => { if (document.hidden) finish('page_hidden') }
    window.addEventListener('keydown', key)
    document.addEventListener('visibilitychange', hidden)
    record('block_start', { ...run.config, seed: run.seed, trials: run.trials, targetRatio: 0.3, stimulusType: 'letter' })
    persist('running', 'checkpoint')
    present()
    return () => {
      finish('navigation')
      clearTimers()
      window.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', hidden)
      response.current = () => {}
      abort.current = () => {}
    }
  }, [run])

  const begin = () => {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!
    logger.current.setSubjectId(subjectId)
    setResults([])
    setIndex(-1)
    setVisible(false)
    setResponded(false)
    setNotice('')
    setStatus('running')
    setRun({ config: { ...config }, trials: generateTrials(config.n, config.count, seed), seed,
      id: crypto.randomUUID(), subjectId, startedAt: new Date().toISOString(),
    })
  }
  const trial = run?.trials[index]
  const percent = summary.accuracy === null ? '—' : `${(summary.accuracy * 100).toFixed(1)}%`

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm">← 返回首页</Link>
          <h1 className="mt-2 text-2xl font-semibold">实验八 · N-back 工作记忆</h1>
          <p className="muted max-w-xl text-sm">当前字母与前 N 个字母相同时，按空格或点「相同」。不相同则不作答。前 N 个字母仅用于记忆，不计分。</p>
        </div>
        <ExportButtons logger={logger.current} subjectId={subjectId} onSubjectChange={setSubjectId} experiment="nback" getSeed={() => run?.seed} recordControl />
      </header>
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Panel title="字母任务" actions={<span className="chip">{running ? `${run!.config.n}-back · ${index + 1}/${run!.trials.length}` : status === 'done' ? '完成' : status === 'stopped' ? '已中止' : '准备'}</span>}>
            <div className="flex min-h-72 flex-col items-center justify-center gap-5 rounded-xl border border-[var(--border)] bg-[var(--bg)] sm:min-h-96">
              <span className="muted text-sm">{running ? trial?.scored ? '判断是否与前 N 个相同' : '记住字母 · 暂不计分' : '点击下方开始'}</span>
              <div className="flex h-36 items-center justify-center font-mono text-8xl font-semibold" aria-label={visible && trial ? `字母 ${trial.letter}` : '注视点'}>{visible && trial ? trial.letter : '+'}</div>
              <span className="muted h-5 text-sm" aria-live="polite">{running && responded ? '已记录作答' : running ? '空格 / 点击相同' : '大写字母'}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button className="btn" disabled={running} onClick={(e) => { e.currentTarget.blur(); begin() }}>开始一轮</button>
              <button className="btn" disabled={!running || responded || index < 0} onClick={(e) => { e.currentTarget.blur(); response.current() }}>相同（空格）</button>
              <button className="btn" disabled={!running} onClick={() => abort.current('user_stop')}>中止本轮</button>
            </div>
            <p className="muted mt-3 text-sm" role="status">{notice || '作答窗口包含字母显示与随后注视点阶段，每题只记录第一次作答。'}</p>
          </Panel>
          <Panel title="本轮结果">
            <p className="muted text-sm" role="status">{saveMessage}</p>
            <div className="mb-4 flex gap-3">
              <Link className="btn" to="/recordings">查看已保存数据</Link>
              <button className="btn" onClick={() => retryNBackSaves(setSaveMessage)}>重试保存</button>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {[['正确率', percent], ['命中 / 漏报', `${summary.hits} / ${summary.misses}`], ['误报 / 正确拒绝', `${summary.falseAlarms} / ${summary.correctRejections}`], ['命中平均反应时', summary.meanHitRtMs === null ? '—' : `${summary.meanHitRtMs.toFixed(0)} ms`], ['已计分试次', summary.total], ['状态', running ? '进行中' : status === 'done' ? '完整一轮' : status === 'stopped' ? '部分结果' : '未开始']].map(([label, value]) => (
                <div key={label}><div className="muted text-xs">{label}</div><div className="mt-1 text-xl font-mono">{value}</div></div>
              ))}
            </div>
            {!running && results.length > 0 && <div className="mt-4 flex flex-wrap gap-2" aria-label="逐试次结果">{results.map((r) => <span key={r.index} className="chip" title={`${OUTCOMES[r.outcome]} · ${r.rtMs === null ? '未作答' : `${r.rtMs.toFixed(0)} ms`}`}>{r.index + 1}: {r.letter} · {OUTCOMES[r.outcome]}</span>)}</div>}
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel title="实验设置">
            <fieldset disabled={running} className="m-0 grid gap-4 border-0 p-0">
              <label className="grid gap-1 text-sm">难度<select className="select" value={config.n} onChange={(e) => setConfig({ ...config, n: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}-back</option>)}</select></label>
              <label className="grid gap-1 text-sm">计分试次数<select className="select" value={config.count} onChange={(e) => setConfig({ ...config, count: Number(e.target.value) })}>{[20, 40, 60, 100].map((n) => <option key={n} value={n}>{n} 次</option>)}</select></label>
              <label className="grid gap-1 text-sm">字母显示时间<select className="select" value={config.stimulusMs} onChange={(e) => setConfig({ ...config, stimulusMs: Number(e.target.value) })}>{[300, 500, 800].map((n) => <option key={n} value={n}>{n} ms</option>)}</select></label>
              <label className="grid gap-1 text-sm">每题总时长<select className="select" value={config.intervalMs} onChange={(e) => setConfig({ ...config, intervalMs: Number(e.target.value) })}>{[1500, 2000, 3000].map((n) => <option key={n} value={n}>{n / 1000} 秒</option>)}</select></label>
            </fieldset>
            <p className="muted mt-4 text-sm">另含 {config.n} 个记忆试次，目标占计分试次的 30%。预计 {((config.count + config.n) * config.intervalMs / 1000).toFixed(0)} 秒。</p>
          </Panel>
          <Panel title="任务说明">
            <p className="text-sm">2-back 示例：A → B → A，第三个字母与前两个位置的字母相同，需要作答；A → B → B 则不作答。</p>
            <p className="muted text-sm">可独立完成行为实验。需要同步 EEG 时，先在采集页开流，再用页顶录制按钮开始录制，结束后停止录制。刺激、作答与结束事件自动关联当前 EEG 会话。</p>
            <p className="muted text-sm">行为数据逐题自动保存，完成或中止后可到「会话库」查看并下载 ZIP，其中 behavior.json 包含本轮设置、序列、作答及成绩。切到后台或离开本页会中止本轮；已完成试次仍会保留。</p>
            <LiveEegBadge />
          </Panel>
        </div>
      </div>
    </main>
  )
}
