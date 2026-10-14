import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { SessionState, TrialRecord } from '../smr-adapt/engine'
import type { CursorState } from '../smr-adapt/smrControl'
import './acquisitionView.css'

const INSTRUCTIONS = { left: '想象左手开合', right: '想象右手开合', up: '想象舌头运动，不实际动作', down: '放松，保持休息' }
const DIRECTIONS = { left: '左', right: '右', up: '上', down: '下' }

type Props = {
  session: SessionState; trial: TrialRecord | null; cursor: CursorState
  running: boolean; starting: boolean; processing: boolean; blocked: boolean
  canContinue: boolean; locked: boolean; live: boolean; operator: ReactNode
  statusMessage: string
  onStart: () => Promise<void>; onContinue: () => Promise<void>; onStop: (reason: string) => void
}

export function AcquisitionView({ session, trial, cursor, running, starting, processing, blocked,
  canContinue, locked, live, operator, statusMessage, onStart, onContinue, onStop }: Props) {
  const surface = useRef<HTMLElement>(null)
  const settings = useRef<HTMLDialogElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const [fullscreenFailed, setFullscreenFailed] = useState(false)
  const hadFullscreen = useRef(false)
  const phase = session.phase
  const resting = phase === 'rest'
  const ended = phase === 'done'
  const interrupted = ended && session.cursor < session.trials.length
  const working = starting || processing
  const targetVisible = trial && ['cue', 'feedback', 'post'].includes(phase)
  const successful = phase === 'post' && trial?.outcome === 'hit'
  const completedGroup = resting ? Math.max(1, (trial?.run ?? 2) - 1) : trial?.run ?? session.plan.blocks[0]?.runs ?? 1

  useEffect(() => {
    const changed = () => {
      if (document.fullscreenElement === surface.current) hadFullscreen.current = true
      else if (hadFullscreen.current) {
        hadFullscreen.current = false
        if (running) onStop('退出全屏')
      }
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && running) onStop('手动终止')
    }
    document.addEventListener('fullscreenchange', changed)
    window.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      window.removeEventListener('keydown', keydown)
    }
  }, [running, onStop])

  async function start(action: () => Promise<void>) {
    setFullscreenFailed(false)
    try {
      if (surface.current?.requestFullscreen && !document.fullscreenElement) await surface.current.requestFullscreen()
    } catch { setFullscreenFailed(true) }
    await action()
  }

  const closeSettings = () => { settings.current?.close(); settingsButton.current?.focus() }

  return (
    <main ref={surface} className="smr-participant" aria-label="SMR 分组采集任务">
      <header className="smr-participant-header">
        <span>运动想象<span className="smr-participant-separator">/</span>水平 / 垂直一维任务</span>
        {!running && <button ref={settingsButton} type="button" className="smr-subtle-button"
          onClick={() => settings.current?.showModal()}>实验员设置</button>}
      </header>

      <div className="smr-participant-field" aria-label="方向与光标任务区">
        {running && trial?.task !== '2D' && <div className={`smr-participant-track is-${trial?.task === 'LR' ? 'horizontal' : 'vertical'}`} aria-hidden="true" />}
        {targetVisible && <div className={`smr-participant-edge is-${trial.target}${successful ? ' is-hit' : ''}`}
          role="img" aria-label={`目标边：${DIRECTIONS[trial.target]}`} />}
        {(phase === 'iti' || phase === 'cue') && <div className="smr-participant-fixation" aria-label="中央注视点" />}
        {(phase === 'feedback' || phase === 'post') && <div className="smr-participant-cursor"
          role="img" aria-label="控制光标" style={{ left: `${cursor.x * 100}%`, top: `${(1 - cursor.y) * 100}%` }} />}

        {running ? <>
          <p className="smr-participant-instruction" role="status">
            {phase === 'iti' ? '注视中央，准备'
              : phase === 'post' ? successful ? '已到达，放松' : '放松，准备下一次'
                : trial ? `${trial.task === 'LR' ? '水平 · ' : trial.task === 'UD' ? '垂直 · ' : ''}${INSTRUCTIONS[trial.target]}` : ''}
          </p>
          <span className="smr-participant-progress">第 {trial?.run} 组 · {(trial?.index ?? 0) + 1} / {session.trials.length}</span>
          <button type="button" className="smr-subtle-button smr-participant-stop" onClick={() => onStop('手动终止')}>停止 · Esc</button>
        </> : <div className="smr-participant-center">
          <div className="smr-participant-rest-dot" aria-hidden="true" />
          <h1>{starting ? '请稍候' : blocked && phase === 'idle' ? '尚未开始本轮' : blocked || interrupted ? '采集已暂停'
            : resting || (ended && processing) ? '休息一下' : ended ? '本轮完成' : '准备好了吗'}</h1>
          <p role="status">{blocked || interrupted ? statusMessage || '请打开实验员设置查看状态并处理。'
            : working ? '可以眨眼、放松，等待下一步。'
              : resting ? '本组已完成。休息好后，继续下一组。'
                : ended ? '谢谢配合，可以休息了。' : '每组先水平、后垂直；沿直线将光标移向亮起的一边。'}</p>
          {!working && !blocked && resting && <button type="button" className="smr-participant-primary"
            disabled={!canContinue} onClick={() => void start(onContinue)}>继续下一组</button>}
          {!locked && !working && !resting && <button type="button" className="smr-participant-primary"
            onClick={() => void start(onStart)}>{ended ? '开始下一轮' : live ? '全屏开始' : '全屏预览'}</button>}
          {phase === 'idle' && !starting && <div className="smr-participant-directions" aria-label="方向说明">
            <span>← 左手</span><span>右手 →</span><span>↑ 舌头</span><span>↓ 放松</span>
          </div>}
          {phase === 'idle' && !live && !starting && <small className="smr-participant-preview">预览模式 · 不录制</small>}
          {fullscreenFailed && phase === 'idle' && <small className="smr-participant-preview">未能进入全屏，可在当前窗口进行任务。</small>}
        </div>}
        {resting && <span className="smr-participant-progress">第 {completedGroup} 组已完成</span>}
      </div>

      <footer className="smr-participant-footer">
        {!locked ? <Link to="/">返回实验目录</Link> : <span />}
        {!running && <span>黄色亮边是目标 · 蓝色圆环是光标</span>}
      </footer>

      <dialog ref={settings} className="smr-operator-dialog" aria-labelledby="smr-operator-title"
        onClick={event => {
          if (event.target !== settings.current) return
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSettings()
        }}>
        <div className="smr-operator-heading">
          <div><small>实验员面板</small><h2 id="smr-operator-title">采集与训练设置</h2></div>
          <nav className="smr-operator-navigation" aria-label="实验员页面导航">
            {!locked ? <Link to="/" className="smr-subtle-button">← 返回实验目录</Link>
              : <button type="button" className="smr-subtle-button" disabled title="请先结束当前采集或等待保存、训练完成">← 返回实验目录</button>}
          <button type="button" className="smr-subtle-button" onClick={closeSettings}>返回被试画面</button>
          </nav>
        </div>
        {operator}
      </dialog>
    </main>
  )
}
