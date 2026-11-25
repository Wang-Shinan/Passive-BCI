import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/ui/Icon'
import { Link, useSearchParams } from 'react-router-dom'
import { mountStudio } from './scene'
import { loadHands } from './genericHand'
import { loadPreviewMouth } from './previewMouth'
import { chapters } from './tasks'
import { smrTrialSeconds } from '../smr-acquisition/trialTiming'
import './studio.css'

function schedule(seconds: { prepare: number; cue: number; imagery: number; recover: number }) {
  const demoStart = seconds.prepare
  const imageryStart = demoStart + seconds.cue
  const recoveryStart = imageryStart + seconds.imagery
  const roundTime = recoveryStart + seconds.recover
  return { ...seconds, demoStart, imageryStart, recoveryStart, roundTime, duration: roundTime * chapters.length }
}
const guidedSchedule = schedule(smrTrialSeconds)
const previewSchedule = schedule({ prepare: 3, cue: 5, imagery: 5, recover: 2 })
const clockText = (t: number) => Math.floor(t / 60) + ':' + String(Math.floor(t) % 60).padStart(2, '0')

function cueAt(t: number, timing: ReturnType<typeof schedule>) {
  const { duration, roundTime, demoStart, imageryStart, recoveryStart } = timing
  if (t >= duration) return { title: '练习结束', hint: '可选择任一动作再次观看。' }
  const local = t % roundTime, chapter = chapters[Math.floor(t / roundTime)]
  if (chapter.id === 'rest') return { title: '静坐放松', hint: chapter.hint }
  if (local < demoStart) return { title: '准备' + chapter.label + '练习', hint: '保持舒适坐姿，等待示范。' }
  if (local < imageryStart) return { title: '观察' + chapter.action, hint: chapter.hint }
  if (local < recoveryStart) return { title: '想象' + chapter.action, hint: chapter.id === 'jaw'
    ? '在心里保持咬住的感觉，直到出现放松提示。实际下颌自然放松。' : chapter.id === 'tongue'
    ? '在心里感受舌头轻触上腭。舌头和下颌保持放松。' : '保持身体静止，在心里感受刚才的动作。' }
  return { title: '放松', hint: '自然休息，准备下一轮。' }
}

function gesture(local: number, jaw: boolean, timing: ReturnType<typeof schedule>) {
  const { cue: demonstrate, demoStart, recoveryStart } = timing
  const t = local - demoStart
  if (jaw) {
    // One closure across demonstration and imagery. Release only in recovery.
    const closeTime = Math.min(1.1, demonstrate * 0.5)
    const fraction = Math.max(0, Math.min(1, t / closeTime, (recoveryStart + 0.8 - local) / 0.8))
    return fraction * fraction * (3 - 2 * fraction)
  }
  if (t < 0 || t >= demonstrate) return 0
  const rampTime = Math.min(1.75, demonstrate * 0.35)
  const fraction = Math.min(1, t / rampTime, (demonstrate - t) / rampTime)
  return fraction * fraction * (3 - 2 * fraction)
}

function breathingGlow(elapsed: number, imagine: number) {
  if (elapsed <= 0 || elapsed >= imagine) return 0
  const period = imagine / 2
  const cycle = (elapsed % period) / period
  // A shorter rise and longer release, with a little red between breaths.
  const ramp = cycle < 0.4 ? cycle / 0.4 : (1 - cycle) / 0.6
  const breath = (1 - Math.cos(Math.PI * ramp)) / 2
  const edge = Math.min(1, elapsed / 0.4, (imagine - elapsed) / 0.4)
  return (0.15 + 0.85 * breath) * edge * edge * (3 - 2 * edge)
}

export default function ArmchairPreview({ onPracticed }: { onPracticed?: () => void } = {}) {
  const timing = onPracticed ? guidedSchedule : previewSchedule
  const { demoStart, imageryStart, recoveryStart, imagery, roundTime, duration } = timing
  const [params] = useSearchParams()
  const requestedChapter = onPracticed ? null : params.get('action')
  const requestedIndex = chapters.findIndex(chapter => chapter.id === requestedChapter)
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const time = useRef(0), running = useRef(false)
  const [tick, setTick] = useState(0), [play, setPlay] = useState(false)
  const [full, setFull] = useState(false), [message, setMessage] = useState('')
  const [sceneError, setSceneError] = useState(''), [ready, setReady] = useState(false)
  function setRunning(on: boolean) { running.current = on; setPlay(on) }
  function seek(t: number) { time.current = t; setTick(Math.floor(t * 20)) }
  function toggle() {
    if (time.current >= duration) seek(0)
    setRunning(!running.current)
  }
  useEffect(() => {
    const surface = canvas.current!
    const controller = new AbortController()
    let studio: ReturnType<typeof mountStudio> | undefined
    let frame = 0, previous: number | null = null, lastTick = -1
    function render(now: number) {
      const dt = previous === null ? 0 : Math.max(0, (now - previous) / 1000)
      if (running.current && previous !== null) {
        time.current = Math.min(duration, time.current + dt)
        if (time.current === duration) {
          setRunning(false)
          onPracticed?.()
        }
      }
      previous = now
      const t = time.current
      const round = Math.min(chapters.length - 1, Math.floor(t / roundTime))
      const local = t - round * roundTime
      const glow = breathingGlow(local - imageryStart, imagery)
      const task = chapters[round].id
      studio?.draw(task, task === 'rest' ? 0 : gesture(local, task === 'jaw', timing), task === 'rest' ? 0 : glow,
        task === 'rest' || local >= recoveryStart, dt)
      const next = Math.floor(t * 20)
      if (next !== lastTick) { lastTick = next; setTick(next) }
      frame = requestAnimationFrame(render)
    }
    function visibility() { previous = null; if (document.hidden) setRunning(false) }
    function lost(e: Event) { e.preventDefault(); setRunning(false); setSceneError('图形渲染中断，请刷新预览。') }
    function fullscreen() { setFull(document.fullscreenElement === root.current) }
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('fullscreenchange', fullscreen)
    surface.addEventListener('webglcontextlost', lost)
    async function start() {
      let hands: Awaited<ReturnType<typeof loadHands>>
      let mouth: Awaited<ReturnType<typeof loadPreviewMouth>> | undefined
      const mouthAsset = loadPreviewMouth(controller.signal).catch(error => {
        if (!onPracticed || controller.signal.aborted) throw error
        setMessage('口腔模型未能加载，已使用备用口腔示范。')
        return undefined
      })
      try { [hands, mouth] = await Promise.all([loadHands(controller.signal), mouthAsset]) }
      catch { if (!controller.signal.aborted) setSceneError('动作模型加载失败，请刷新重试。'); return }
      if (controller.signal.aborted) return
      try { studio = mountStudio(surface, hands, mouth) }
      catch { setSceneError('无法绘制 3D 场景。请启用浏览器图形加速后刷新。'); return }
      setReady(true)
      if (requestedIndex >= 0) seek(requestedIndex * roundTime + (chapters[requestedIndex].id === 'rest' ? 0 : demoStart))
      if (onPracticed || requestedIndex >= 0) setRunning(true)
      frame = requestAnimationFrame(render)
    }
    void start()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('fullscreenchange', fullscreen)
      surface.removeEventListener('webglcontextlost', lost)
      controller.abort()
      studio?.dispose()
    }
  }, [onPracticed, requestedIndex, timing, demoStart, imageryStart, recoveryStart, imagery, roundTime, duration])
  async function fullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen()
      else await root.current!.requestFullscreen()
      setMessage('')
    } catch { setMessage('浏览器未能进入全屏，仍可在窗口内预览。') }
  }
  const t = tick / 20, round = Math.min(chapters.length - 1, Math.floor(t / roundTime))
  const cue = cueAt(t, timing)
  return <main className="arm-studio" ref={root}>
    <canvas ref={canvas} aria-label="第一人称三维场景，双手放在椅子扶手上，面向湖景窗户" />
    {ready && chapters[round].id === 'rest' && t < duration && <div className="arm-fixation" aria-hidden="true" />}
    <header className="arm-header">
      <div className="arm-heading"><span className="arm-stamp">SMR</span><h1>运动想象练习室</h1></div>
      {onPracticed ? <button onClick={onPracticed}>结束熟悉，进入采集</button> :
        <div className="arm-controls"><Link to="/smr-acquisition">进入 SMR 采集</Link>
        <button onClick={fullscreen}><Icon name="focus" size={16} />{full ? '退出全屏' : '全屏预览'}</button></div>}
    </header>
    {message && <div className="arm-note" role="status">{message}</div>}
    {sceneError ? <div className="arm-error" role="alert">{sceneError}</div> : !ready ?
      <div className="arm-note" role="status">正在加载动作模型…</div> :
      <>
        <div className="arm-instructions" data-fixation={chapters[round].id === 'rest' && t < duration || undefined} aria-live="polite">
          <h2 key={cue.title}>{cue.title}</h2><p>{cue.hint}</p>
        </div>
      <footer className="arm-dock">
        <span className="arm-round">第 {round + 1} / {chapters.length} 轮</span>
        <div className="arm-transport">
          <div className="arm-chapters" aria-label="选择示范轮次">{chapters.map((chapter, i) =>
            <button key={chapter.id} aria-label={'播放第 ' + (i + 1) + ' 轮' + chapter.label + '示范'} aria-current={i === round ? 'step' : undefined}
              onClick={() => { seek(i * roundTime + (chapter.id === 'rest' ? 0 : demoStart)); setRunning(true) }}>
              {chapter.label}
              <span style={{ width: (Math.min(1, Math.max(0, t / roundTime - i)) * 100) + '%' }} />
            </button>
          )}</div>
          <div className="arm-controls"><button className="arm-start" onClick={toggle}><Icon name={play ? 'pause' : 'play'} size={15} />{play ? '暂停' : t >= duration ? '重新播放' : t > 0 ? '继续播放' : '开始练习'}</button>
            <span className="arm-time">{clockText(t)} / {clockText(duration)}</span>
          </div>
        </div>
      </footer></>}
  </main>
}
