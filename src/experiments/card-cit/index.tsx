import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { FeatureMonitorPanel, useFeatureMonitor } from '../../lib/features'
import { SessionLogger } from '../../lib/logger'
import { calibratedNow, keyTimestamp, sleep } from '../../lib/timing'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import { CardFace, CardStage } from './CardStage'
import { dealHand, type Card } from './deck'
import { detect, type DetectionResult, type TrialResult } from './detector'
import {
  buildSchedule,
  DEFAULT_DEADLINE_MS,
  DEFAULT_FLASH_MS,
  type FlashTrial,
} from './schedule'

type Phase = 'setup' | 'memorize' | 'flash' | 'guess' | 'feedback'

interface RoundHistory {
  guessId: string | null
  correct: boolean | null
  chance: number
  scores: DetectionResult['scores']
}

export function CardCitExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const features = useFeatureMonitor({ active: true })
  const [handSize, setHandSize] = useState(10)
  const [seed, setSeed] = useState(() => (Math.random() * 0xffffffff) >>> 0)
  const [cards, setCards] = useState<Card[]>(() => dealHand(10, seed))
  const [phase, setPhase] = useState<Phase>('setup')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0, round: 0 })
  const [results, setResults] = useState<TrialResult[]>([])
  const [detection, setDetection] = useState<DetectionResult | null>(null)
  const [history, setHistory] = useState<RoundHistory[]>([])
  const [flashMs, setFlashMs] = useState(DEFAULT_FLASH_MS)
  const [deadlineMs, setDeadlineMs] = useState(DEFAULT_DEADLINE_MS)
  const [status, setStatus] = useState('准备开始')

  const loggerRef = useRef(new SessionLogger('card-cit', subjectId))
  const abortRef = useRef(false)
  const onsetRef = useRef<number | null>(null)
  const respondedRef = useRef(false)
  const currentTrialRef = useRef<FlashTrial | null>(null)
  const resultsAccRef = useRef<TrialResult[]>([])

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  const redeal = (n = handSize) => {
    abortRef.current = true
    const s = (Math.random() * 0xffffffff) >>> 0
    setSeed(s)
    setCards(dealHand(n, s))
    setPhase('setup')
    setHighlightId(null)
    setResults([])
    setDetection(null)
    setProgress({ done: 0, total: 0, round: 0 })
    setStatus('已重新发牌')
    resultsAccRef.current = []
    loggerRef.current.log('redeal', { seed: s, handSize: n })
  }

  const recordKey = useCallback(
    (e: KeyboardEvent) => {
      if (phase !== 'flash') return
      if (e.code !== 'Space' && e.key !== ' ') return
      e.preventDefault()
      if (respondedRef.current || onsetRef.current === null || !currentTrialRef.current) return
      respondedRef.current = true
      const rt = keyTimestamp(e) - onsetRef.current
      const trial = currentTrialRef.current
      const valid = rt >= 0 && rt <= deadlineMs
      const row: TrialResult = {
        cardId: trial.cardId,
        round: trial.round,
        rtMs: valid ? rt : rt,
        valid,
        reason: valid ? 'ok' : 'timeout',
      }
      // If somehow negative (clock skew), mark miss
      if (rt < 0) {
        row.valid = false
        row.rtMs = null
        row.reason = 'miss'
      } else if (rt > deadlineMs) {
        row.valid = false
        row.reason = 'timeout'
      }
      resultsAccRef.current.push(row)
      loggerRef.current.log('response', {
        cardId: row.cardId,
        round: row.round,
        rtMs: row.rtMs,
        valid: row.valid,
        reason: row.reason,
      })
    },
    [phase, deadlineMs],
  )

  useEffect(() => {
    window.addEventListener('keydown', recordKey)
    return () => window.removeEventListener('keydown', recordKey)
  }, [recordKey])

  const runFlash = useCallback(async () => {
    abortRef.current = false
    const schedule = buildSchedule(
      cards.map((c) => c.id),
      { rounds: 3, seed: seed ^ 0xabcddcba, flashMs, deadlineMs },
    )
    resultsAccRef.current = []
    setResults([])
    setDetection(null)
    setPhase('flash')
    setProgress({ done: 0, total: schedule.length, round: 1 })
    setStatus('闪动中：每次高亮按空格表示「不是我的牌」')
    loggerRef.current.log('flash_start', { trials: schedule.length, flashMs, deadlineMs })

    // Brief blank before first flash
    await sleep(800)
    if (abortRef.current) return

    for (let i = 0; i < schedule.length; i++) {
      if (abortRef.current) return
      const trial = schedule[i]!
      currentTrialRef.current = trial
      respondedRef.current = false
      onsetRef.current = null
      setProgress({ done: i, total: schedule.length, round: trial.round })
      setHighlightId(trial.cardId)

      const onset = await calibratedNow()
      onsetRef.current = onset
      loggerRef.current.log('flash_onset', {
        cardId: trial.cardId,
        round: trial.round,
        onset,
        index: i,
      })

      await sleep(flashMs)

      // Wait remaining deadline window for late responses, then ISI
      const afterFlash = performance.now()
      const remainDeadline = Math.max(0, deadlineMs - (afterFlash - onset))
      await sleep(remainDeadline)

      if (!respondedRef.current) {
        const row: TrialResult = {
          cardId: trial.cardId,
          round: trial.round,
          rtMs: null,
          valid: false,
          reason: 'miss',
        }
        resultsAccRef.current.push(row)
        loggerRef.current.log('response', {
          cardId: row.cardId,
          round: row.round,
          rtMs: null,
          valid: false,
          reason: 'miss',
        })
      }

      onsetRef.current = null
      currentTrialRef.current = null
      // Keep the card highlighted during the whole response window to make
      // the stimulus feel like a continuous slideshow.
      setHighlightId(null)

      // ISI after deadline window (trial.isiMs is inter-stimulus idle)
      await sleep(trial.isiMs)
    }

    if (abortRef.current) return

    const finalResults = [...resultsAccRef.current]
    setResults(finalResults)
    const det = detect(
      finalResults,
      cards.map((c) => c.id),
    )
    setDetection(det)
    setPhase('guess')
    setStatus('系统已给出猜测，请反馈对错（系统只记录这一 bit）')
    loggerRef.current.log('guess', { guessId: det.guessId, chance: det.chance })
  }, [cards, seed, flashMs, deadlineMs])

  const onFeedback = (correct: boolean) => {
    if (!detection) return
    const entry: RoundHistory = {
      guessId: detection.guessId,
      correct,
      chance: detection.chance,
      scores: detection.scores,
    }
    setHistory((h) => [...h, entry])
    setPhase('feedback')
    setStatus(correct ? '猜对了' : '猜错了')
    loggerRef.current.log('feedback', {
      guessId: detection.guessId,
      correct,
    })
  }

  const accuracy = useMemo(() => {
    const answered = history.filter((h) => h.correct !== null)
    if (answered.length === 0) return null
    const ok = answered.filter((h) => h.correct).length
    return ok / answered.length
  }, [history])

  const chartData = (detection?.scores ?? []).map((s) => ({
    id: s.cardId,
    z: s.z ?? 0,
    medianRt: s.medianRt ?? 0,
    highlight: s.cardId === detection?.guessId,
  }))

  const guessCard = cards.find((c) => c.id === detection?.guessId)
  const flashCard =
    phase === 'flash' && highlightId ? cards.find((c) => c.id === highlightId) ?? null : null

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-1 text-2xl font-semibold">实验三 · 扑克牌隐藏信息测试</h1>
          <p className="muted m-0 mt-1 text-sm">
            心里选一张牌写在纸上（页面不记录）。闪动时尽量欺骗系统——但对目标牌按空格需要抑制，反应时可能泄漏。
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
        />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_280px]">
        <CardStage
          cards={cards}
          highlightId={highlightId}
          phase={
            phase === 'setup'
              ? '准备'
              : phase === 'memorize'
                ? '识记 / 心选'
                : phase === 'flash'
                  ? `闪动 ${progress.done + 1}/${progress.total} · 第 ${progress.round} 轮`
                  : phase === 'guess'
                    ? '猜测'
                    : '反馈'
          }
        />

        <div className="space-y-4">
          <Panel title="流程">
            <p className="muted mb-3 text-sm">{status}</p>
            <div className="flex flex-col gap-2">
              {(phase === 'setup' || phase === 'feedback') && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setPhase('memorize')
                    setStatus('请心选一张牌并写在纸上，确认后开始闪动。页面不会记录你的选择。')
                    loggerRef.current.log('memorize')
                  }}
                >
                  {phase === 'feedback' ? '再来一局' : '开始识记'}
                </button>
              )}
              {phase === 'memorize' && (
                <button type="button" className="btn btn-primary" onClick={() => void runFlash()}>
                  我已选好，开始闪动
                </button>
              )}
              {phase === 'flash' && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    abortRef.current = true
                    setPhase('setup')
                    setHighlightId(null)
                    setStatus('已中止')
                  }}
                >
                  中止
                </button>
              )}
              {phase === 'guess' && detection && (
                <>
                  <div className="rounded-xl border border-[var(--border)] bg-[#0f1526] p-3 text-center">
                    <div className="muted text-xs">系统猜测</div>
                    <div className="mt-2 flex justify-center">
                      {guessCard ? <CardFace card={guessCard} size="md" highlight /> : '—'}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" className="btn btn-primary" onClick={() => onFeedback(true)}>
                      对
                    </button>
                    <button type="button" className="btn btn-danger" onClick={() => onFeedback(false)}>
                      错
                    </button>
                  </div>
                </>
              )}
              <button type="button" className="btn" onClick={() => redeal()}>
                重新发牌
              </button>
            </div>
          </Panel>

          <Panel title="参数">
            <Slider label="牌数" value={handSize} min={5} max={16} step={1} onChange={setHandSize} />
            <button
              type="button"
              className="btn mt-2 w-full"
              onClick={() => redeal(handSize)}
              disabled={phase === 'flash'}
            >
              应用牌数并重发
            </button>
            <div className="mt-3 space-y-3">
              <Slider
                label="闪动时长 (ms)"
                value={flashMs}
                min={150}
                max={600}
                step={10}
                onChange={setFlashMs}
                disabled={phase === 'flash'}
              />
              <Slider
                label="响应死线 (ms)"
                value={deadlineMs}
                min={400}
                max={2000}
                step={50}
                onChange={setDeadlineMs}
                disabled={phase === 'flash'}
              />
            </div>
          </Panel>

          <Panel title="累计正确率">
            {accuracy === null ? (
              <p className="muted text-sm">尚无反馈。</p>
            ) : (
              <div>
                <div className="font-mono text-2xl">{(accuracy * 100).toFixed(0)}%</div>
                <p className="muted text-xs">
                  {history.filter((h) => h.correct).length}/{history.length} · 随机水平约{' '}
                  {((detection?.chance ?? 1 / cards.length) * 100).toFixed(1)}%
                </p>
              </div>
            )}
          </Panel>

          <LiveEegBadge />
          <FeatureMonitorPanel
            compact
            latest={features.latest}
            history={features.history}
            analyzing={features.analyzing}
            enabledIds={features.enabledIds}
            onEnabledChange={features.onEnabledChange}
            note={
              features.origin === 'live'
                ? '正在分析采集页的实时 EEG（与 RT 检测独立）。'
                : '合成 EEG；采集页开流后会自动切到实时。与 RT 检测独立。'
            }
          />
        </div>
      </div>

      {flashCard && (
        <div className="flash-fullscreen" aria-hidden>
          <div key={flashCard.id} className="flash-fullscreen-card flash-fullscreen-fade">
            <CardFace card={flashCard} size="lg" highlight />
          </div>
        </div>
      )}

      {(phase === 'guess' || phase === 'feedback') && chartData.length > 0 && (
        <Panel title="各牌反应时 z-score（越高越像目标牌）" className="mt-4">
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={chartData}>
                <CartesianGrid stroke="#243049" strokeDasharray="3 3" />
                <XAxis dataKey="id" stroke="#9aa8c7" tick={{ fontSize: 11 }} />
                <YAxis stroke="#9aa8c7" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: '#141b2d',
                    border: '1px solid #2a3550',
                    borderRadius: 8,
                  }}
                />
                <Bar dataKey="z" name="z-score">
                  {chartData.map((d) => (
                    <Cell key={d.id} fill={d.highlight ? '#f5a524' : '#5b8cff'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="muted mt-2 text-xs">
            有效试次基于中位数 RT；超时 / 漏按单独计为无效，防止「整体变慢」策略。
            本轮有效 {results.filter((r) => r.valid).length}/{results.length}。
          </p>
        </Panel>
      )}
    </div>
  )
}

export default CardCitExperiment
