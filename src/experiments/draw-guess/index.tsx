import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { Link } from 'react-router-dom'
import { SessionLogger } from '../../lib/logger'
import { mulberry32, randomSeed } from '../../lib/rng'
import { ManualSignalSource } from '../../lib/signal/manual'
import { FeatureMonitorPanel, SignalModeControls, useAffectControl } from '../../lib/features'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import {
  DEFAULT_GUESS_CONFIG,
  formatStreamingMarkdown,
  loadGuessConfig,
  normalizeApiKey,
  normalizeGuessEndpoint,
  requestFollowUpGuess,
  requestGuess,
  saveGuessConfig,
  type AffectiveSignals,
  type ChatMessage,
  type GuessApiConfig,
  type GuessItem,
  type GuessResult,
} from './guessApi'
import { WORD_BANK, pickWord } from './words'
import './drawGuess.css'

type Phase = 'idle' | 'drawing' | 'guessing' | 'review'

const COLORS = ['#1f2430', '#e74c3c', '#2ecc71', '#3498db', '#f39c12', '#9b59b6']

const DEFAULT_SIGNALS: AffectiveSignals = {
  satisfaction: 50,
  surprise: 40,
  focus: 55,
  arousal: 45,
}

interface TranscriptEntry {
  id: number
  kind: 'assistant' | 'user_feedback'
  title: string
  markdown: string
  guesses?: GuessItem[]
  signals?: AffectiveSignals
  streaming?: boolean
}

interface StrokePoint {
  x: number
  y: number
}

export function DrawGuessExperiment() {
  const [subjectId, setSubjectId] = useState('S01')
  const [phase, setPhase] = useState<Phase>('idle')
  const [secretWord, setSecretWord] = useState('')
  const [round, setRound] = useState(0)
  const [score, setScore] = useState(0)
  const [historyWords, setHistoryWords] = useState<string[]>([])
  const [color, setColor] = useState(COLORS[0]!)
  const [brush, setBrush] = useState(4)
  const {
    mode,
    setMode,
    signals,
    updateSignal: setAffectChannel,
    resetSignals,
    drivers,
    features,
  } = useAffectControl(DEFAULT_SIGNALS)
  const [feedback, setFeedback] = useState('')
  const [guesses, setGuesses] = useState<GuessItem[]>([])
  const [lastResult, setLastResult] = useState<GuessResult | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [turn, setTurn] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [notice, setNotice] = useState(
    '开始后你会看到要画的词；画完后让 AI 猜测，再用四维信号 + 文字反馈进行多轮纠正。',
  )
  const [busy, setBusy] = useState(false)
  const [apiConfig, setApiConfig] = useState<GuessApiConfig>(() =>
    typeof window === 'undefined' ? DEFAULT_GUESS_CONFIG : loadGuessConfig(),
  )
  const [showApi, setShowApi] = useState(false)

  const loggerRef = useRef(new SessionLogger('draw-guess', subjectId))
  const signalRefs = useRef({
    satisfaction: new ManualSignalSource({ kind: 'generic', id: 'satisfaction', initial: 50 }),
    surprise: new ManualSignalSource({ kind: 'generic', id: 'surprise', initial: 40 }),
    focus: new ManualSignalSource({ kind: 'generic', id: 'focus', initial: 55 }),
    arousal: new ManualSignalSource({ kind: 'generic', id: 'arousal', initial: 45 }),
  })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPointRef = useRef<StrokePoint | null>(null)
  const undoStackRef = useRef<ImageData[]>([])
  const rngRef = useRef(mulberry32(randomSeed()))
  const strokeCountRef = useRef(0)
  const roundStartedAtRef = useRef(0)
  const revealedRef = useRef(false)

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#fffdf8'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [])

  const pushUndo = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
    if (undoStackRef.current.length > 40) undoStackRef.current.shift()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const resize = () => {
      const rect = parent.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(320, Math.floor(rect.width))
      const h = Math.max(360, Math.floor(Math.min(window.innerHeight * 0.58, 520)))
      const prev = canvas.toDataURL()
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#fffdf8'
      ctx.fillRect(0, 0, w, h)
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, w, h)
      img.src = prev
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const getPos = (event: React.PointerEvent<HTMLCanvasElement>): StrokePoint => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (phase !== 'drawing') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pushUndo()
    drawingRef.current = true
    const p = getPos(event)
    lastPointRef.current = p
    const ctx = event.currentTarget.getContext('2d')
    if (!ctx) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.lineWidth = brush
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ctx.lineTo(p.x + 0.01, p.y)
    ctx.stroke()
    strokeCountRef.current += 1
    loggerRef.current.log('stroke_start', { color, brush, x: Math.round(p.x), y: Math.round(p.y) })
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || phase !== 'drawing') return
    const ctx = event.currentTarget.getContext('2d')
    const last = lastPointRef.current
    if (!ctx || !last) return
    const p = getPos(event)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    ctx.lineWidth = brush
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastPointRef.current = p
  }

  const onPointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    lastPointRef.current = null
    loggerRef.current.log('stroke_end', { strokes: strokeCountRef.current })
  }

  const undo = () => {
    const canvas = canvasRef.current
    const snap = undoStackRef.current.pop()
    if (!canvas || !snap) return
    const ctx = canvas.getContext('2d')
    ctx?.putImageData(snap, 0, 0)
    loggerRef.current.log('undo')
  }

  const startRound = () => {
    const seed = randomSeed()
    rngRef.current = mulberry32(seed)
    const word = pickWord(historyWords, rngRef.current)
    setSecretWord(word)
    setHistoryWords((prev) => [...prev, word].slice(-20))
    setRound((r) => r + 1)
    setPhase('drawing')
    setGuesses([])
    setLastResult(null)
    setChatMessages([])
    setTranscript([])
    setTurn(0)
    setRevealed(false)
    revealedRef.current = false
    setFeedback('')
    resetSignals(DEFAULT_SIGNALS)
    strokeCountRef.current = 0
    undoStackRef.current = []
    roundStartedAtRef.current = performance.now()
    clearCanvas()
    loggerRef.current.log('round_start', { seed, word, round: round + 1 })
    setNotice(`请画出「${word}」。画完后点「让 AI 猜」，再用信号与文字反馈多轮纠正。`)
  }

  const updateSignal = (key: keyof AffectiveSignals, value: number) => {
    setAffectChannel(key, value)
    signalRefs.current[key].push(value)
    loggerRef.current.log('signal', { channel: key, value, origin: mode })
  }

  // When feature-driven, mirror derived values into SignalSource + log sparsely via effect.
  useEffect(() => {
    if (mode !== 'features' && mode !== 'live') return
    ;(Object.keys(signals) as (keyof AffectiveSignals)[]).forEach((key) => {
      signalRefs.current[key].push(signals[key])
    })
  }, [mode, signals])

  const applyAssistantResult = (result: GuessResult, turnIndex: number, streamId?: number) => {
    setLastResult(result)
    setGuesses(result.guesses)
    setChatMessages(result.messages)
    setTurn(turnIndex)
    const hit = result.guesses.some((g) => g.word === secretWord)
    if (hit && !revealedRef.current) {
      revealedRef.current = true
      setRevealed(true)
      setScore((s) => s + 1)
    } else if (hit) {
      setRevealed(true)
    }
    const entry: TranscriptEntry = {
      id: streamId ?? Date.now() + turnIndex,
      kind: 'assistant',
      title: `AI 第 ${turnIndex} 轮猜测`,
      markdown: result.displayMarkdown ?? result.rawText ?? '',
      guesses: result.guesses,
      streaming: false,
    }
    setTranscript((prev) => {
      if (streamId != null && prev.some((e) => e.id === streamId)) {
        return prev.map((e) => (e.id === streamId ? entry : e))
      }
      return [...prev, entry]
    })
    const fellBack = Boolean(result.rawText?.startsWith('remote_failed:'))
    loggerRef.current.log('guess_result', {
      provider: result.provider,
      latencyMs: result.latencyMs,
      guesses: result.guesses,
      hit,
      secretWord,
      turn: turnIndex,
      fellBack,
      hasReasoning: Boolean(result.reasoning),
      remoteError: fellBack ? result.rawText : undefined,
    })
    if (hit) {
      setNotice(`AI 猜中了「${secretWord}」！可继续反馈观察其对信号的理解，或开始下一轮。`)
    } else {
      setNotice(
        fellBack
          ? '远程失败已回退本地。请调节四维信号并提交反馈，让 AI 继续猜。'
          : `第 ${turnIndex} 轮已解包 ${result.guesses.length} 个猜测。请调节四维信号 + 文字反馈后提交，AI 会据此再猜。`,
      )
    }
  }

  const patchStream = (streamId: number, content: string, reasoning?: string) => {
    const markdown = formatStreamingMarkdown(content, reasoning)
    setTranscript((prev) =>
      prev.map((e) => (e.id === streamId ? { ...e, markdown, streaming: true } : e)),
    )
  }

  const askAi = async () => {
    const canvas = canvasRef.current
    if (!canvas || phase !== 'drawing') return
    setBusy(true)
    setPhase('guessing')
    setNotice('AI 正在逐字输出…')
    const streamId = Date.now()
    setTranscript((prev) => [
      ...prev,
      {
        id: streamId,
        kind: 'assistant',
        title: 'AI 第 1 轮猜测',
        markdown: '_正在思考…_',
        streaming: true,
      },
    ])
    loggerRef.current.log('guess_request', {
      provider: apiConfig.useLocal || !apiConfig.apiKey ? 'local' : 'openai',
      strokes: strokeCountRef.current,
      drawMs: Math.round(performance.now() - roundStartedAtRef.current),
      turn: 1,
      stream: true,
    })
    try {
      const result = await requestGuess({
        canvas,
        config: apiConfig,
        wordBank: WORD_BANK,
        secretWord,
        onDelta: ({ content, reasoning }) => patchStream(streamId, content, reasoning),
      })
      setPhase('review')
      applyAssistantResult(result, 1, streamId)
    } catch (error) {
      setPhase('drawing')
      setTranscript((prev) => prev.filter((e) => e.id !== streamId))
      const message = error instanceof Error ? error.message : String(error)
      setNotice(`猜测失败：${message}`)
      loggerRef.current.log('guess_error', { message })
    } finally {
      setBusy(false)
    }
  }

  const submitFeedback = async () => {
    const canvas = canvasRef.current
    if (!canvas || phase !== 'review' || !lastResult) return
    if (busy) return

    const feedbackSnap = feedback.trim()
    const signalsSnap = { ...signals }
    const nextTurn = turn + 1
    const userMd = [
      '### 用户反馈',
      '',
      `- 满意度 **${signalsSnap.satisfaction}**（示意：是否接近答案）`,
      `- 惊讶度 **${signalsSnap.surprise}**（示意：是否过于离谱）`,
      `- 专注度 **${signalsSnap.focus}**（示意：是否愿跟随推理）`,
      `- 活跃度 **${signalsSnap.arousal}**（示意：是否愿积极纠正）`,
      '',
      feedbackSnap ? feedbackSnap : '_（无文字反馈）_',
    ].join('\n')

    const streamId = Date.now() + 1
    setTranscript((prev) => [
      ...prev,
      {
        id: Date.now(),
        kind: 'user_feedback',
        title: `用户反馈 · 第 ${turn} → ${nextTurn} 轮`,
        markdown: userMd,
        signals: signalsSnap,
      },
      {
        id: streamId,
        kind: 'assistant',
        title: `AI 第 ${nextTurn} 轮猜测`,
        markdown: '_正在根据反馈思考…_',
        streaming: true,
      },
    ])

    loggerRef.current.log('feedback', {
      text: feedbackSnap,
      signals: signalsSnap,
      hit: guesses.some((g) => g.word === secretWord),
      secretWord,
      guesses,
      round,
      turn,
    })

    setBusy(true)
    setPhase('guessing')
    setNotice('AI 正在根据四维信号与文字反馈逐字修正…')
    try {
      const result = await requestFollowUpGuess({
        canvas,
        config: apiConfig,
        wordBank: WORD_BANK,
        secretWord,
        priorMessages: chatMessages,
        previousGuesses: guesses,
        signals: signalsSnap,
        feedbackText: feedbackSnap,
        onDelta: ({ content, reasoning }) => patchStream(streamId, content, reasoning),
      })
      setPhase('review')
      setFeedback('')
      applyAssistantResult(result, nextTurn, streamId)
    } catch (error) {
      setPhase('review')
      setTranscript((prev) => prev.filter((e) => e.id !== streamId))
      const message = error instanceof Error ? error.message : String(error)
      setNotice(`多轮反馈失败：${message}`)
      loggerRef.current.log('guess_error', { message, turn: nextTurn })
    } finally {
      setBusy(false)
    }
  }

  const persistApi = () => {
    const next = {
      ...apiConfig,
      endpoint: normalizeGuessEndpoint(apiConfig.endpoint),
      apiKey: normalizeApiKey(apiConfig.apiKey),
    }
    setApiConfig(next)
    saveGuessConfig(next)
    setNotice(
      next.useLocal || !next.apiKey
        ? '已保存：当前使用本地演示猜测（无需密钥）。'
        : `已保存：${next.endpoint} · model=${next.model} · key长度=${next.apiKey.length}`,
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-white">
            ← 返回实验列表
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="m-0 text-2xl font-semibold">你画我猜 · AI</h1>
            <span className="chip">Draw & Guess</span>
          </div>
          <p className="muted mt-2 max-w-2xl text-sm">
            画完后让 AI 猜（流式逐字输出）；再把满意度 / 惊讶度 / 专注度 / 活跃度与文字反馈送回，进行多轮纠正。JSON
            会自动解包，推理以 Markdown 展示。
          </p>
        </div>
        <ExportButtons
          logger={loggerRef.current}
          subjectId={subjectId}
          onSubjectChange={setSubjectId}
        />
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="draw-word-pill">
              {phase === 'idle' ? '等待开始' : `第 ${round} 轮 · 请画：${secretWord}`}
            </div>
            <span className="chip">得分 {score}/{round || 0}</span>
            {turn > 0 && <span className="chip">对话轮次 {turn}</span>}
            {lastResult && (
              <span className="chip">
                {lastResult.provider === 'local' ? '本地演示' : 'Vision API'} ·{' '}
                {lastResult.latencyMs} ms
              </span>
            )}
            {revealed && <span className="chip">已猜中</span>}
          </div>

          <div className="draw-toolbar">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`draw-swatch${color === c ? ' active' : ''}`}
                style={{ background: c }}
                aria-label={`颜色 ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
            <label className="muted flex items-center gap-2 text-sm">
              粗细
              <input
                type="range"
                min={2}
                max={16}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
              />
            </label>
            <button type="button" className="btn" onClick={undo} disabled={phase !== 'drawing'}>
              撤销
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                pushUndo()
                clearCanvas()
                loggerRef.current.log('clear')
              }}
              disabled={phase !== 'drawing'}
            >
              清空
            </button>
          </div>

          <div className="draw-stage">
            <canvas
              ref={canvasRef}
              className="draw-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>

          <div className="rounded-xl border border-[#2a3550] bg-[#0d1425] px-4 py-3 text-sm">
            {notice}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={startRound} disabled={busy}>
              {phase === 'idle' ? '开始' : '下一轮'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={askAi}
              disabled={busy || phase !== 'drawing'}
            >
              {busy && phase === 'guessing' && turn === 0 ? '猜测中…' : '让 AI 猜'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setRevealed(true)}
              disabled={!secretWord || revealed}
            >
              揭示答案
            </button>
            <button type="button" className="btn" onClick={() => setShowApi((v) => !v)}>
              {showApi ? '收起 API' : 'API 设置'}
            </button>
          </div>

          {transcript.length > 0 && (
            <Panel title={`多轮对话 · 已解包猜测${guesses.length ? `（当前 Top ${guesses.length}）` : ''}`}>
              {guesses.length > 0 && (
                <div className="draw-guess-list mb-4">
                  {guesses.map((g, i) => (
                    <div
                      key={`${g.word}-${i}`}
                      className={`draw-guess-item${revealed && g.word === secretWord ? ' hit' : ''}`}
                    >
                      <span>
                        {i + 1}. {g.word}
                      </span>
                      <strong>{(g.confidence * 100).toFixed(0)}%</strong>
                    </div>
                  ))}
                </div>
              )}

              <div className="draw-transcript" ref={(el) => {
                if (el && transcript.some((t) => t.streaming)) {
                  el.scrollTop = el.scrollHeight
                }
              }}>
                {transcript.map((entry) => (
                  <article
                    key={entry.id}
                    className={`draw-turn ${entry.kind === 'assistant' ? 'assistant' : 'user'}${
                      entry.streaming ? ' streaming' : ''
                    }`}
                  >
                    <header className="muted mb-2 text-xs">
                      {entry.title}
                      {entry.streaming ? ' · 流式输出中' : ''}
                    </header>
                    <div className="draw-md">
                      {entry.streaming ? (
                        <pre className="draw-stream">
                          {entry.markdown}
                          <span className="draw-caret" aria-hidden />
                        </pre>
                      ) : (
                        <Markdown>{entry.markdown}</Markdown>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {lastResult?.rawText?.startsWith('remote_failed:') && (
                <pre className="draw-raw-error mt-4">{lastResult.rawText}</pre>
              )}
            </Panel>
          )}
        </main>

        <aside className="space-y-4">
          <Panel
            title="情感 / 认知信号"
            actions={
              <span className="chip" style={{ color: mode !== 'manual' ? 'var(--accent-2)' : 'var(--muted)' }}>
                {mode === 'live' ? '实时 EEG' : mode === 'features' ? '演示数据' : '手动'}
              </span>
            }
          >
            <SignalModeControls
              mode={mode}
              onModeChange={setMode}
              affectDrivers={drivers}
            />
            <div className="draw-signals">
              <Slider
                label={mode !== 'manual' ? '满意度（特征输出，只读）' : '满意度'}
                value={Math.round(signals.satisfaction)}
                min={0}
                max={100}
                onChange={(v) => updateSignal('satisfaction', v)}
                disabled={mode !== 'manual'}
              />
              <Slider
                label={mode !== 'manual' ? '惊讶度（特征输出，只读）' : '惊讶度'}
                value={Math.round(signals.surprise)}
                min={0}
                max={100}
                onChange={(v) => updateSignal('surprise', v)}
                disabled={mode !== 'manual'}
              />
              <Slider
                label={mode !== 'manual' ? '专注度（特征输出，只读）' : '专注度'}
                value={Math.round(signals.focus)}
                min={0}
                max={100}
                onChange={(v) => updateSignal('focus', v)}
                disabled={mode !== 'manual'}
              />
              <Slider
                label={mode !== 'manual' ? '活跃度（特征输出，只读）' : '活跃度'}
                value={Math.round(signals.arousal)}
                min={0}
                max={100}
                onChange={(v) => updateSignal('arousal', v)}
                disabled={mode !== 'manual'}
              />
            </div>
            <p className="muted mb-0 mt-3 text-xs leading-relaxed">
              {mode === 'live'
                ? '实时 EEG 正在调控四维信号；点「手动输入」接管。'
                : mode === 'features'
                  ? '演示数据正在调控四维信号；点「手动输入」接管。'
                  : '提交反馈时会一并送给 AI。可切「演示数据」或「实时 EEG」。'}
            </p>
          </Panel>

          <FeatureMonitorPanel
            compact
            latest={features.latest}
            history={features.history}
            analyzing={features.analyzing}
            enabledIds={features.enabledIds}
            onEnabledChange={features.onEnabledChange}
            note={
              mode === 'live'
                ? features.origin === 'live'
                  ? '实时 EEG 调控情感通道。'
                  : '已选实时 EEG，等待采集页样本。'
                : mode === 'features'
                  ? '演示数据调控情感通道。点「手动输入」接管。'
                  : '手动模式；可切「演示数据」或「实时 EEG」。'
            }
          />

          <Panel title="文字反馈 → 让 AI 再猜">
            <textarea
              className="draw-feedback"
              placeholder="例如：差得很远 / 接近了但方向不对 / 请注意顶部那个尖角…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={phase !== 'review' || busy}
            />
            <button
              type="button"
              className="btn btn-primary mt-3 w-full"
              onClick={submitFeedback}
              disabled={phase !== 'review' || busy || !lastResult}
            >
              {busy && phase === 'guessing' && turn > 0 ? 'AI 修正中…' : '提交反馈并继续猜'}
            </button>
          </Panel>

          {showApi && (
            <Panel title="AI 猜测 API">
              <label className="mb-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={apiConfig.useLocal || !apiConfig.apiKey}
                  onChange={(e) =>
                    setApiConfig((c) => ({ ...c, useLocal: e.target.checked }))
                  }
                />
                使用本地演示猜测（无需密钥）
              </label>
              <label className="mb-2 block text-sm">
                <span className="muted">Endpoint（Kimi Coding Plan）</span>
                <input
                  className="mt-1 w-full rounded-lg border border-[#2a3550] bg-[#0d1425] px-3 py-2 text-sm"
                  value={apiConfig.endpoint}
                  onChange={(e) => setApiConfig((c) => ({ ...c, endpoint: e.target.value }))}
                  placeholder="https://api.kimi.com/coding/v1/chat/completions"
                />
              </label>
              <label className="mb-2 block text-sm">
                <span className="muted">API Key</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-[#2a3550] bg-[#0d1425] px-3 py-2 text-sm"
                  value={apiConfig.apiKey}
                  onChange={(e) =>
                    setApiConfig((c) => ({
                      ...c,
                      apiKey: e.target.value,
                      useLocal: e.target.value.trim() ? false : c.useLocal,
                    }))
                  }
                  placeholder="Kimi Code Console 里创建的 Key"
                />
              </label>
              <label className="mb-3 block text-sm">
                <span className="muted">Model</span>
                <input
                  className="mt-1 w-full rounded-lg border border-[#2a3550] bg-[#0d1425] px-3 py-2 text-sm"
                  value={apiConfig.model}
                  onChange={(e) => setApiConfig((c) => ({ ...c, model: e.target.value }))}
                  placeholder="k3"
                  list="draw-guess-models"
                />
                <datalist id="draw-guess-models">
                  <option value="k3" />
                  <option value="k3-256k" />
                  <option value="kimi-for-coding" />
                  <option value="kimi-for-coding-highspeed" />
                </datalist>
              </label>
              <button type="button" className="btn w-full" onClick={persistApi}>
                保存到本机
              </button>
              <p className="muted mb-0 mt-3 text-xs leading-relaxed">
                默认对接{' '}
                <a
                  className="underline"
                  href="https://www.kimi.com/code/docs/en/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Kimi Coding Plan
                </a>
                ：endpoint <code>api.kimi.com/coding/v1</code>，猜图建议用 <code>k3</code>
                （带视觉）。请求经 Vite <code>/api/llm</code> 代理。密钥来自 Kimi Code Console，只存
                localStorage。
              </p>
            </Panel>
          )}

          <Panel title="玩法">
            <ul className="muted m-0 space-y-2 pl-4 text-sm">
              <li>开始后记住词语，在白板上画出它（不要写字）</li>
              <li>点「让 AI 猜」上传画布；默认本地演示，可接真实 Vision API</li>
              <li>看完猜测后调节四维信号，写下文字反馈并提交</li>
              <li>全部事件可导出 JSON / CSV</li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  )
}
