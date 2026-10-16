import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { modelRuntimeHub } from '../../lib/model-runtime/modelRuntimeHub'
import { useModelRuntime } from '../../lib/model-runtime/useModelRuntime'
import { IceGame, DIRECTIONS, type Direction } from './engine'
import { LEVELS } from './levels'
import { KeyboardInput, KEY_DIRECTIONS } from './input'
import { BciCommandFilter, DEFAULT_FILTER, MI_MAPPING, MAPPING_PRESETS, mappingForLabels,
  fromModelPrediction, mappingMatches, validFrame, migrateFilterConfig,
  type PredictionFrame, type ClassMapping, type FilterConfig, type MappingPreset } from './bci'
import { connectNeuroSlide } from './connection'
import { S04_MODEL_OPTIONS, S04_HEAD } from '../../lib/model-runtime/subjectModels'
import './neuroslide.css'

const ARROW: Record<Direction, string> = { up: '↑', down: '↓', left: '←', right: '→' }
const WORD: Record<Direction, string> = { up: '上', down: '下', left: '左', right: '右' }
const CLASS_TEXT: Record<string, string> = { left_hand: '左手想象', right_hand: '右手想象', feet: '双脚想象', tongue: '舌头想象', rest: '休息', left: '左方向', right: '右方向', up: '上方向', down: '下方向' }
const STORAGE_KEY = 'neuroslide.config.v1'
function loadSettings(): { mapping: ClassMapping; config: FilterConfig; preset: MappingPreset } {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (stored && DIRECTIONS.every(d => typeof stored.mapping?.[d] === 'string')) {
      const config = migrateFilterConfig(stored.config)
      const preset = ['auto', 'mi', 'smr', 'directions', 'custom'].includes(stored.preset) ? stored.preset :
        DIRECTIONS.every(d => stored.mapping[d] === MI_MAPPING[d]) ? 'auto' : 'custom'
      return { ...stored, config, preset }
    }
  } catch { /* Use safe defaults for unavailable storage or invalid saved configuration. */ }
  return { mapping: { ...MI_MAPPING }, config: { ...DEFAULT_FILTER }, preset: 'auto' }
}
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function NeuroSlidePage() {
  const [settings, setSettings] = useState(loadSettings)
  const [levelIndex, setLevelIndex] = useState(0)
  const [mode, setMode] = useState<'keyboard' | 'bci'>('keyboard')
  const [source, setSource] = useState<'runtime' | 'external'>('runtime')
  const game = useRef(new IceGame(LEVELS[0]!))
  const filter = useRef(new BciCommandFilter(settings.mapping, settings.config))
  const keyboard = useRef(new KeyboardInput())
  const controls = useRef({ mode, source })
  const [view, setView] = useState({ state: game.current.state, point: game.current.state.position })
  const [frame, setFrame] = useState<PredictionFrame | null>(null)
  const [signal, setSignal] = useState('键盘已就绪 · 每次按下只发出一个方向')
  const [configError, setConfigError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [modelHead, setModelHead] = useState(() => {
    try {
      const saved = localStorage.getItem('neuroslide.model-head')
      return saved ?? S04_HEAD
    } catch { return S04_HEAD }
  })
  const [connectionMessage, setConnectionMessage] = useState('')
  const selectedModel = S04_MODEL_OPTIONS.find(option => option.id === modelHead)
  const connection = useRef<AbortController | null>(null)
  const [externalFresh, setExternalFresh] = useState(false)
  const runtime = useModelRuntime()
  const state = view.state
  const level = LEVELS[levelIndex]!
  const now = () => performance.now()
  const refresh = () => setView({ state: game.current.state, point: game.current.visualPosition(now()) })
  const invalidate = () => { filter.current.interrupt(now()); setSignal(filter.current.message) }
  const start = () => {
    filter.current.begin(now()); setSignal(filter.current.message)
    game.current.start(now()); refresh()
  }
  const stopConnecting = () => { connection.current?.abort(); setConnecting(false) }
  const pauseGame = () => { stopConnecting(); invalidate(); game.current.pause(now()); refresh() }
  const applySettings = (mapping: ClassMapping, config: FilterConfig, preset = settings.preset) => {
    try {
      filter.current.configure(mapping, config, now())
      setSettings({ mapping, config, preset }); setConfigError(''); setSignal(filter.current.message)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ mapping, config, preset })) } catch { /* Session settings still work. */ }
    } catch (error) { setConfigError(String(error)) }
  }
  const reset = (index = levelIndex) => {
    stopConnecting()
    invalidate(); game.current.restart(LEVELS[index]!); setLevelIndex(index); refresh()
  }
  const changeMode = (next: 'keyboard' | 'bci') => {
    connection.current?.abort(); setConnecting(false)
    controls.current.mode = next; setMode(next); invalidate(); game.current.pause(now()); refresh()
  }

  useEffect(() => () => connection.current?.abort(), [])

  const connect = async () => {
    connection.current?.abort()
    const controller = new AbortController()
    connection.current = controller
    controls.current = { mode: 'bci', source: 'runtime' }
    setMode('bci'); setSource('runtime'); setConnecting(true)
    invalidate(); game.current.pause(now()); refresh()
    try {
      await connectNeuroSlide(controller.signal, setConnectionMessage, modelHead || undefined)
      if (!controller.signal.aborted && !document.hidden) start()
    }
    catch (error) { if (!controller.signal.aborted) setConnectionMessage(error instanceof Error ? error.message : String(error)) }
    finally { if (!controller.signal.aborted) setConnecting(false) }
  }

  useEffect(() => {
    let raf = 0
    let alive = true
    const update = () => {
      if (!alive) return
      const timestamp = performance.now()
      const engine = game.current
      const wasSliding = Boolean(engine.state.slide)
      engine.tick(timestamp)
      if (wasSliding && !engine.state.slide) filter.current.interrupt(timestamp)
      if (engine.state.status === 'running' || wasSliding) {
        setView({ state: engine.state, point: engine.visualPosition(timestamp) })
      }
      raf = requestAnimationFrame(update)
    }
    raf = requestAnimationFrame(update)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (!KEY_DIRECTIONS[event.code]) return
      const target = event.target as HTMLElement | null
      const editing = Boolean(target?.closest('input, select, textarea, [contenteditable="true"]'))
      if (!editing && controls.current.mode === 'keyboard') event.preventDefault()
      const direction = keyboard.current.down(event.code, event.repeat,
        !editing && controls.current.mode === 'keyboard' && game.current.acceptsInput)
      if (direction && game.current.command(direction, performance.now())) {
        setSignal(`单次指令 ${ARROW[direction]} · ${game.current.state.slide ? '滑行中，输入不缓存' : '前方是墙，等待下一次指令'}`)
        setView({ state: game.current.state, point: game.current.visualPosition(performance.now()) })
      }
    }
    const up = (event: KeyboardEvent) => keyboard.current.up(event.code)
    const pause = () => {
      keyboard.current.blur(); filter.current.interrupt(performance.now())
      game.current.pause(performance.now())
      setView({ state: game.current.state, point: game.current.visualPosition(performance.now()) })
    }
    const blur = () => {
      keyboard.current.blur()
      // Native dropdowns and other windows can blur without hiding the BCI display.
      // Brain input does not depend on keyboard focus. Hidden tabs still pause.
      if (controls.current.mode === 'keyboard') pause()
    }
    const visibility = () => { if (document.hidden) pause() }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  useEffect(() => {
    // Both inputs pass through the same gate. There is deliberately no movement queue.
    const receive = (prediction: PredictionFrame, origin: 'runtime' | 'external') => {
      if (origin !== controls.current.source) return
      if (!prediction || !validFrame(prediction)) { setSignal('预测格式无效'); return }
      setFrame(prediction)
      const direction = filter.current.consume(prediction, performance.now(),
        controls.current.mode === 'bci' && game.current.acceptsInput &&
        (origin === 'external' || modelRuntimeHub.snapshot.status === 'ready'))
      setSignal(filter.current.message)
      if (direction) {
        game.current.command(direction, performance.now())
        setView({ state: game.current.state, point: game.current.visualPosition(performance.now()) })
      }
    }
    const syncRuntime = () => {
      const snapshot = modelRuntimeHub.snapshot
      if (controls.current.source === 'runtime' && snapshot.status !== 'ready') filter.current.interrupt(performance.now())
      if (snapshot.latestPrediction) receive(fromModelPrediction(snapshot.latestPrediction), 'runtime')
    }
    const unsubscribe = modelRuntimeHub.subscribe(syncRuntime)
    syncRuntime()
    const external = (event: Event) => receive((event as CustomEvent<PredictionFrame>).detail, 'external')
    window.addEventListener('neuroslide:prediction', external)
    return () => { unsubscribe(); window.removeEventListener('neuroslide:prediction', external) }
  }, [])

  useEffect(() => {
    const update = () => setExternalFresh(Boolean(frame && performance.now() - frame.receivedAt <= settings.config.maxGapMs))
    update()
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [frame, settings.config.maxGapMs])

  const reportedLabels = source === 'runtime' ? runtime.serviceHello?.class_names ?? frame?.labels : frame?.labels
  const labelsKey = JSON.stringify(reportedLabels ?? [])
  useEffect(() => {
    if (settings.preset !== 'auto') return
    const detected = mappingForLabels(JSON.parse(labelsKey) as string[])
    if (detected && DIRECTIONS.some(d => detected[d] !== settings.mapping[d])) {
      applySettings({ ...detected }, settings.config, 'auto')
    }
    // Only a new label set or an explicit selection may change the mapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelsKey, settings.preset])
  const matches = !reportedLabels || mappingMatches(reportedLabels, settings.mapping)
  const probabilitiesFresh = mode === 'bci' && externalFresh && (source === 'external' || runtime.status === 'ready')
  const statusText = state.status === 'won' ? '关卡完成' : state.pausePending ? '抵达停点后暂停' : state.slide ? '滑行中 · 输入锁定' :
    state.status === 'paused' ? '已暂停' : state.status === 'idle' ? '准备就绪' : '等待下一个方向'
  const connectionText = mode === 'keyboard' ? '离线键盘演示' : source === 'external' ? (externalFresh ? '外部预测已接入' : '等待外部预测') :
    runtime.status === 'ready' ? (externalFresh ? '模型已连接 · 预测在线' : '模型已连接 · 等待新预测') : `模型未连接 · ${runtime.status}`
  const inputStatus = state.status === 'paused' ? '已暂停 · 点击「继续」恢复指令输出' : state.status === 'idle' ? '尚未开始 · 点击「开始」接收指令' :
    state.status === 'won' ? '本关已完成' : state.slide ? '滑行中 · 本次指令执行完毕前不接受新输入' : signal
  const highestProbability = frame ? Math.max(...frame.probabilities) : 0
  const ambiguous = probabilitiesFresh && highestProbability < .3

  return <main className="ns-page">
    <header className="ns-header">
      <div className="ns-brand"><div className="ns-brand-mark">N<span>↗</span></div><div>
        <p className="ns-eyebrow">MOTOR IMAGERY / FOUR-CLASS CONTROL</p>
        <h1>NeuroSlide <span>— BCI Ice Maze</span></h1>
      </div></div>
      <div className="ns-header-side"><span className="ns-live"><i />{connectionText}</span><Link to="/">返回实验目录 ↗</Link></div>
    </header>

    <div className="ns-toolbar">
      <label>探索区域<select aria-label="关卡选择" value={levelIndex} onChange={e => reset(Number(e.target.value))}>
        {LEVELS.map((item, i) => <option key={item.id} value={i}>0{i + 1} · {item.name} / {item.difficulty}</option>)}
      </select></label>
      <div className="ns-mode" aria-label="输入模式">
        <button className={mode === 'keyboard' ? 'is-active' : ''} onClick={() => changeMode('keyboard')}>Keyboard Demo</button>
        <button className={mode === 'bci' ? 'is-active' : ''} onClick={() => changeMode('bci')}>BCI Mode</button>
      </div>
      <div className="ns-actions">
        <button className="ns-primary" disabled={connecting || state.status === 'running' || state.status === 'won'} onClick={start}>{state.status === 'paused' ? '继续' : '开始'}</button>
        <button disabled={(!connecting && state.status !== 'running') || state.pausePending} onClick={pauseGame}>暂停</button>
        <button onClick={() => reset()}>重新开始</button>
        <button aria-label="全屏展示" onClick={() => {
          const action = document.fullscreenElement ? document.exitFullscreen() : document.querySelector('.ns-page')?.requestFullscreen()
          void action?.catch(() => setSignal('浏览器未允许全屏，可使用 F11'))
        }}>⛶</button>
      </div>
    </div>

    <div className="ns-layout">
      <section className="ns-arena" aria-label="冰面迷宫">
        <div className="ns-arena-heading"><div><p className="ns-eyebrow">SECTOR 0{levelIndex + 1} / {level.difficulty}</p><h2>{level.name}</h2></div>
          <span className={`ns-status ${state.slide ? 'is-sliding' : ''}`} role="status">{statusText}</span></div>
        <div className="ns-board-wrap">
          <svg className="ns-board" viewBox={`0 0 ${level.rows[0]!.length * 64} ${level.rows.length * 64}`} role="img" aria-label={`${level.name}，玩家位置 ${state.position.x}, ${state.position.y}`}>
            <defs>
              <linearGradient id="ns-ice" x2="1" y2="1"><stop stopColor="#143955"/><stop offset="1" stopColor="#102a43"/></linearGradient>
              <linearGradient id="ns-wall" x2="0" y2="1"><stop stopColor="#28415c"/><stop offset="1" stopColor="#14283e"/></linearGradient>
              <radialGradient id="ns-player"><stop stopColor="#e5ffff"/><stop offset=".45" stopColor="#80f9f3"/><stop offset="1" stopColor="#13b8ce"/></radialGradient>
              <pattern id="ns-grain" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M8 54 22 40M43 18l9-9" stroke="#65b3cb" strokeOpacity=".1" strokeWidth="1"/></pattern>
              <filter id="ns-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="7"/></filter>
            </defs>
            {level.rows.flatMap((row, y) => [...row].map((tile, x) => <g key={`${x},${y}`} transform={`translate(${x * 64},${y * 64})`}>
              {tile === '#' ? <><rect x="2" y="2" width="60" height="60" rx="8" fill="url(#ns-wall)" stroke="#36536e" strokeWidth="1"/><path d="M12 9h40" stroke="#60839d" strokeOpacity=".38"/></> :
                <><rect x="1" y="1" width="62" height="62" rx="3" fill="url(#ns-ice)" stroke="#24516a" strokeOpacity=".5"/><rect width="64" height="64" fill="url(#ns-grain)"/></>}
              {tile === 'S' && <><rect x="13" y="13" width="38" height="38" rx="9" fill="none" stroke="#65e2db" strokeDasharray="3 4" opacity=".55"/><text x="32" y="38" textAnchor="middle" fill="#74c2c5" fontSize="17">S</text></>}
              {tile === 'G' && <g className="ns-goal"><circle cx="32" cy="32" r="26" fill="#f4c678" opacity=".1"/><circle cx="32" cy="32" r="22" fill="none" stroke="#ecc376" strokeWidth="2"/><path d="m32 17 4 10 11 5-11 4-4 11-5-11-10-4 10-5Z" fill="#ffdb98"/></g>}
            </g>))}
            {state.slide && <path d={`M${state.slide.from.x * 64 + 32} ${state.slide.from.y * 64 + 32} L${view.point.x * 64 + 32} ${view.point.y * 64 + 32}`} stroke="#6cf4ef" strokeWidth="10" opacity=".16" strokeLinecap="round"/>}
            <g className="ns-player" data-x={state.position.x} data-y={state.position.y} data-sliding={Boolean(state.slide)} transform={`translate(${view.point.x * 64 + 32},${view.point.y * 64 + 32})`}>
              <circle r="25" fill="#55f7ef" opacity=".5" filter="url(#ns-glow)"/><circle r="20" fill="url(#ns-player)"/>
              <circle r="25" fill="none" stroke="#9dfff8" strokeOpacity=".55" strokeWidth="1"/>
              <path d="m0-10 8 10-8 10-8-10Z" fill="#10394a"/>
            </g>
          </svg>
          {(state.status === 'idle' || state.status === 'paused') && <div className="ns-board-note">{state.status === 'idle' ? '点击「开始」，用一个方向开启探索' : '探索已暂停 · 点击「继续」'}<span>每次滑行自动抵达墙前，无需控制距离</span></div>}
          {state.status === 'won' && <div className="ns-victory" role="status"><div className="ns-victory-star">✦</div><p className="ns-eyebrow">DESTINATION REACHED</p><h2>成功抵达终点</h2><p>{state.moves} 次操作 <span>·</span> {clock(state.elapsedMs)}</p><button className="ns-primary" onClick={() => reset((levelIndex + 1) % LEVELS.length)}>{levelIndex < 2 ? '探索下一区域 →' : '返回极光入口 →'}</button></div>}
        </div>
        <footer className="ns-arena-footer"><div><span className="ns-dot ns-cyan"/>探索者 <span className="ns-dot ns-gold"/>终点 <span className="ns-wall-key"/>冰墙</div><span>滑过岔路 · 遇墙停下 · 停在终点即通关</span></footer>
      </section>

      <aside className="ns-sidebar">
        <section className="ns-panel ns-direction-panel"><p className="ns-eyebrow">COMMAND / 当前方向</p>
          <div className="ns-direction-display"><div className={state.slide ? 'ns-big-arrow moving' : 'ns-big-arrow'}>{state.direction ? ARROW[state.direction] : '◇'}</div><div><strong>{state.direction ? `向${WORD[state.direction]}` : '等待指令'}</strong>{state.slide && <p>滑行中 · 不接受新指令</p>}</div></div>
          <div className="ns-stats"><div><span>操作次数</span><strong data-testid="moves">{String(state.moves).padStart(2, '0')}</strong></div><div><span>探索用时</span><strong data-testid="elapsed">{clock(state.elapsedMs)}</strong></div></div>
        </section>

        <section className="ns-panel"><div className="ns-panel-heading"><h2>四分类识别</h2><span>{mode === 'keyboard' ? 'DEMO / 无 EEG' : probabilitiesFresh ? 'LIVE' : '等待数据'}</span></div>
          <div className="ns-probabilities">{(['left', 'right', 'down', 'up'] as const).map(direction => {
            const label = settings.mapping[direction]
            const index = frame?.labels.indexOf(label) ?? -1
            const probability = probabilitiesFresh && index >= 0 ? frame!.probabilities[index]! : null
            return <div className="ns-probability" key={direction}><div><span className="ns-small-arrow">{ARROW[direction]}</span><span>{CLASS_TEXT[label] ?? label}<small>{label}</small></span><b>{probability == null ? '—' : `${(probability * 100).toFixed(0)}%`}</b></div><div className="ns-bar"><i style={{ width: `${(probability ?? 0) * 100}%` }}/></div></div>
          })}</div>
          <p className="ns-filter-state" aria-live="polite">{mode === 'keyboard' ? '方向键单次触发；长按不会连续滑行。' : inputStatus}</p>
          {mode === 'bci' && (state.status === 'paused' || state.status === 'idle') && <button className="ns-primary" disabled={connecting} onClick={start}>{state.status === 'paused' ? '继续脑控' : '开始脑控'}</button>}
          {ambiguous && <p className="ns-warning">四类接近 25%，尚无明确分类证据。请核对下方实际模型版本；不会将微小概率差当成方向。</p>}
          {!matches && <p className="ns-warning">模型真实类别：{reportedLabels?.join(' / ')}。与当前映射不一致，移动已禁用。</p>}
        </section>

        <section className="ns-panel ns-instructions"><p className="ns-eyebrow">HOW TO EXPLORE</p><div className="ns-keycaps"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd><span>松开后，再给出下一次指令</span></div></section>

        <details className="ns-panel ns-settings"><summary>BCI 连接与过滤设置 <span>⌄</span></summary>
          <label>预测来源<select aria-label="预测来源" value={source} onChange={e => {
            const next = e.target.value as typeof source
            connection.current?.abort(); setConnecting(false); setConnectionMessage('')
            controls.current.source = next; setSource(next); setFrame(null); invalidate(); game.current.pause(now()); refresh()
          }}><option value="runtime">现有 EEG 模型服务</option><option value="external">外部独立试次接口</option></select></label>
          {source === 'runtime' && <><label>脑控分类模型<select aria-label="脑控分类模型" value={modelHead} disabled={connecting} onChange={e => {
            pauseGame(); setModelHead(e.target.value); setConnectionMessage('已选择；点击「连接模型并开始」后应用。')
            try { localStorage.setItem('neuroslide.model-head', e.target.value) } catch { /* Session choice still works. */ }
          }}>{S04_MODEL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            {modelHead && !selectedModel && <option value={modelHead}>{modelHead}</option>}
            <option value="">沿用当前服务 / 项目配置</option></select></label>
            <p>S04 历史版本 · 北京时间。选定后点击连接按钮应用；下方「实际模型」显示正在运行的版本。</p>
            {selectedModel && <div className="ns-model-detail" data-testid="selected-model-detail">
              <p>{selectedModel.description}</p><p>{selectedModel.id}</p>
            </div>}
            <button disabled={connecting} onClick={() => { void connect() }}>{connecting ? '正在连接 EEG 与模型…' : '连接模型并开始'}</button>{connectionMessage && <p role="status" data-testid="connection-message">{connectionMessage}</p>}<p>{runtime.url}<br/>{runtime.sourceDetail}<br/>实际模型：<span data-testid="model-revision">{runtime.serviceHello?.model_revision ?? '尚未连接'}</span><br/>窗口 {runtime.windowSec}s · 已发送窗口 {runtime.sentWindows} · 已收到预测 {runtime.predictionCount}</p><Link to="/online-learn">打开模型配置 ↗</Link>{runtime.lastError && <p className="ns-warning">{runtime.lastError}</p>}</>}
          <label>类别映射预设<select aria-label="类别映射预设" value={settings.preset} onChange={e => {
            const preset = e.target.value as MappingPreset
            const mapping = preset === 'auto' ? mappingForLabels(reportedLabels ?? []) ?? settings.mapping :
              preset === 'custom' ? settings.mapping : MAPPING_PRESETS[preset]
            applySettings({ ...mapping }, settings.config, preset)
          }}><option value="auto">自动匹配模型真实类别</option><option value="mi">标准 MI：左手 / 右手 / 双脚 / 舌头</option><option value="smr">当前 SMR：左手 / 右手 / 休息 / 舌头</option><option value="directions">方向头：left / right / down / up</option><option value="custom">自定义标签映射</option></select></label>
          <p>已核实当前 SMR 为 left_hand / right_hand / tongue / rest；rest 是休息，不是双脚。按真实标签匹配，不按概率数组顺序猜测。</p>
          <div className="ns-mapping">{DIRECTIONS.map(direction => <label key={direction}>{ARROW[direction]} 向{WORD[direction]}<input aria-label={`向${WORD[direction]}类别标签`} value={settings.mapping[direction]} onChange={e => applySettings({ ...settings.mapping, [direction]: e.target.value }, settings.config, 'custom')}/></label>)}</div>
          <div className="ns-mapping">{([
            ['threshold', '置信度阈值', .26, 1, .01], ['stableCount', '稳定预测数', 1, 30, 1],
            ['releaseThreshold', '释放阈值', .25, .99, .01], ['releaseCount', '释放预测数', 1, 30, 1],
          ] as const).map(([key, label, min, max, step]) => <label key={key}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={settings.config[key]} onChange={e => applySettings(settings.mapping, { ...settings.config, [key]: Number(e.target.value) })}/></label>)}</div>
          <fieldset className="ns-rest-debug">
            <legend>rest 独立稳定预测调试</legend>
            <label>rest 稳定预测数<input aria-label="rest 稳定预测数" type="number" min={1} max={30} step={1}
              value={settings.config.restStableCount}
              onChange={e => applySettings(settings.mapping, { ...settings.config, restStableCount: Number(e.target.value) })}/></label>
            <p>休息类连续 {settings.config.restStableCount} 次达到置信度阈值才确认。其他类别仍使用上方「稳定预测数」。</p>
            {!Object.values(settings.mapping).includes('rest') && <p>当前映射不含 rest，此项在接入 rest 类后生效。</p>}
          </fieldset>
          {configError && <p className="ns-warning">{configError}</p>}
          <p>连续流：先连续 {settings.config.releaseCount} 次最高概率 ≤ {settings.config.releaseThreshold}，再连续确认同类概率 ≥ {settings.config.threshold}：rest 需 {settings.config.restStableCount} 次，其他类别需 {settings.config.stableCount} 次。持续高置信度不会连续移动；释放不等于 rest 类。</p>
          <p>独立试次接口可传 roundId；同一试次最多执行一次，滑行期间试次直接丢弃。操作次数包含撞墙指令。暂停会在本次滑行抵达停点后生效。</p>
        </details>
      </aside>
    </div>
    <footer className="ns-page-footer"><span>NEUROSLIDE / DISCRETE INTENT, FLUID MOTION</span><span>4 种方向 · 0 距离控制 · 无限探索</span></footer>
  </main>
}
