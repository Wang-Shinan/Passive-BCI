import { ModelHeadPicker } from '../../lib/model-runtime/ModelHeadPicker'
import { preferredModelHead } from '../../lib/model-runtime/modelServiceApi'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Board } from '../tetris/Board'
import { createGame, move, rotate, softDropBurst, advanceFall, advanceBoardAnim, type GameState } from '../tetris/engine'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { SessionLogger } from '../../lib/logger'
import { mulberry32, randomSeed } from '../../lib/rng'
import { recorderIsActive, startExperimentRecording, stopExperimentRecording } from '../../lib/session/recordControl'
import { loadStoredSubjectId } from '../../lib/ui/ExportButtons'
import { copyRecentSamples } from '../smr-adapt/smrControl'
import { DIRECTIONS, gazeFeatures, parseGazeModel, predictGaze, type GazeModel, type Direction } from './classifier'
import { gazeModel, connectGazeModel, gazePrediction, type GazeReport } from './reveGaze'
import './gazeTetris.css'

type Active = { game: GameState; rng: () => number; model: GazeReport | null; eye: GazeModel | null;
  baseline: Float32Array[] | null; ready: number; last: number; actionAt: number; paused: boolean;
  channels: string[]; hz: number; logger: SessionLogger }

export function tetrisDirection(probabilities: number[]): Direction | null {
  if (probabilities.length !== 4 || probabilities.some(p => !Number.isFinite(p) || p < 0)) return null
  const sorted = [...probabilities].sort((a,b) => b-a)
  if (sorted[0]! < .55 || sorted[0]! - sorted[1]! < .15) return null
  return DIRECTIONS[probabilities.indexOf(sorted[0]!)]!
}

export function GazeTetrisPage({ eyeOnly = false }: { eyeOnly?: boolean }) {
  const [subject,setSubject] = useState(() => loadStoredSubjectId('S03'))
  const [game,setGame] = useState(() => createGame(1))
  const [running,setRunning] = useState(false)
  const [busy,setBusy] = useState(false)
  const [paused,setPaused] = useState(false)
  const [notice,setNotice] = useState('')
  const [cell,setCell] = useState(26)
  const active = useRef<Active | null>(null)
  const owned = useRef(false)
  const mounted = useRef(true)
  const starting = useRef(false)
  const experiment = eyeOnly ? 'gaze-tetris' : 'gaze-smr-tetris'

  const stop = async (reason = '手动结束') => {
    const s = active.current
    active.current = null; setRunning(false); setPaused(false); setBusy(true)
    s?.logger.log('session_end', { reason, score: s.game.score, lines: s.game.lines })
    try { if (owned.current) { owned.current = false; const saved = await stopExperimentRecording(); setNotice(saved.message) } }
    catch(e) { setNotice(String(e)) } finally { setBusy(false) }
  }
  const start = async () => {
    if (starting.current || active.current) return
    starting.current = true; setBusy(true)
    try {
      if (recorderIsActive()) throw new Error('请先保存并结束当前录制，再开始游戏会话')
      if (!liveEegHub.isFresh() || liveEegHub.meta.device === 'demo') throw new Error('请先连接真实 EEG 并开始采集')
      const channels = [...liveEegHub.meta.channelNames], hz = liveEegHub.meta.sampleRate
      const headId = preferredModelHead('gaze_smr')
      const model = eyeOnly ? null : await gazeModel(undefined, undefined, headId)
      const eye = eyeOnly ? parseGazeModel(localStorage.getItem(`passive-bci.gaze-model.v1.${subject}`)) : null
      const selected = eyeOnly ? eye : model
      if (!selected || selected.subjectId !== subject || selected.sampleRate !== hz || selected.channels.join('|') !== channels.join('|')) throw new Error('需要本被试相同通道、采样率的已训练模型；请先完成对应采集')
      if (!eyeOnly) await connectGazeModel(headId)
      if (!mounted.current) return
      const seed = randomSeed(), logger = new SessionLogger(experiment,subject)
      const rec = await startExperimentRecording({ experiment,subjectId: subject,seed })
      owned.current = rec.ok
      if (!mounted.current) { if (owned.current) { owned.current=false; await stopExperimentRecording() }; return }
      if (!rec.ok || rec.sink !== 'disk') throw new Error('游戏会话需要本地 EEG 与事件落盘')
      const now = performance.now(), next = createGame(seed)
      active.current = { game: next,rng: mulberry32(seed),model,eye,baseline:null,ready:now+3000,last:now,actionAt:now,paused:false,channels,hz,logger }
      logger.log('session_start',{ protocol:`${experiment}-v1`,mode:'game',seed,channels,sampleRate:hz,
        decoder:eyeOnly?'eeg-gaze-regularized-diagonal-lda':'reve-lp',modelRevision:model?.modelRevision,headId:eyeOnly?null:headId || 'gaze_smr_active.pt',
        eyeModelCreatedAt:eye?.createdAt,activeClasses:model?.activeClasses ?? DIRECTIONS,predictionVisible:true,
        instructions:eyeOnly?'注视希望操作的方向，无需运动想象':'注视方向并做对应运动想象：左手/右手/双手/休息',
        actions:{left:'left',right:'right',up:'rotate',down:'softDrop'},labelsAre:'decoded_game_actions_not_ground_truth' })
      setGame(next); setRunning(true); setPaused(false); setNotice('注视中央准备 3 秒')
    } catch(e) {
      setNotice(String(e))
      if (owned.current) { owned.current=false; await stopExperimentRecording().catch(() => {}) }
    } finally { starting.current=false; setBusy(false) }
  }
  const apply = (s: Active,d: Direction,source: string) => {
    const r = d === 'left' || d === 'right' ? move(s.game,d === 'left' ? -1 : 1,s.rng)
      : d === 'up' ? rotate(s.game,1,s.rng) : softDropBurst(s.game,s.rng,.1,10)
    s.game=r.state
    s.logger.log('gaze_tetris_action',{direction:d,source,piece:s.game.piece,score:s.game.score,events:r.events})
  }
  const tick = useEffectEvent(() => {
    const s=active.current
    if (!s) return
    const now=performance.now(), dt=Math.min(.1,(now-s.last)/1000); s.last=now
    if (!recorderIsActive()) { void stop('录制中断'); return }
    if (s.paused) return
    if (s.channels.join('|') !== liveEegHub.meta.channelNames.join('|') || s.hz !== liveEegHub.meta.sampleRate) { void stop('通道或采样率改变'); return }
    if (!liveEegHub.isFresh() || now-liveEegHub.meta.lastAt>500) { s.ready=now+3000; s.baseline=null; setNotice('EEG 中断，游戏已冻结；恢复后重新准备'); return }
    if (now < s.ready) return
    const read = (sec: number) => liveEegHub.ring.buffers.map(b => copyRecentSamples(b,liveEegHub.ring.writeHead,liveEegHub.ring.filled,Math.round(sec*s.hz)))
    if (s.eye && !s.baseline) { s.baseline=read(1); s.ready=now+3000; setNotice('中央基线完成，等待眼动窗口'); return }
    let direction: Direction | null=null
    if (s.model) {
      const p=gazePrediction(s.model,s.ready)
      if (!p) { setNotice('等待当前 REVE 头的有效预测，游戏冻结'); return }
      direction=tetrisDirection(p.probabilities)
    } else if (s.eye && s.baseline) {
      try { direction=predictGaze(s.eye,gazeFeatures(s.baseline,read(3),s.hz)) } catch { setNotice('眼动窗口不足'); return }
    }
    if (direction && now-s.actionAt >= (direction==='up' ? 900 : 450)) {
      apply(s,direction,eyeOnly?'eeg-gaze':'reve-lp'); s.actionAt=now
    }
    const gravity=s.game.anim ? advanceBoardAnim(s.game,s.rng,dt*1000) : advanceFall(s.game,s.rng,dt,.6)
    s.game=gravity.state
    for (const event of gravity.events) s.logger.log('tetris_event',event)
    setGame(s.game); setNotice(direction ? `解码方向：${direction}` : '等待明确方向')
    if (s.game.gameOver) void stop('游戏结束')
  })
  useEffect(() => { const id=setInterval(()=>tick(),40); return ()=>clearInterval(id) },[])
  const pause = () => {
    const s=active.current; if (!s) return
    s.paused=!s.paused; s.ready=performance.now()+3000; s.baseline=null
    s.logger.log('game_pause',{paused:s.paused}); setPaused(s.paused); setNotice(s.paused?'游戏已暂停，录制保留':'注视中央准备 3 秒')
  }
  useEffect(() => {
    mounted.current=true
    const hidden=()=>{ const s=active.current; if(document.hidden && s && !s.paused) { s.paused=true; s.logger.log('game_pause',{paused:true,reason:'hidden'}); setPaused(true); setNotice('页面切到后台，游戏已暂停') } }
    document.addEventListener('visibilitychange',hidden)
    return ()=>{ mounted.current=false; document.removeEventListener('visibilitychange',hidden); active.current?.logger.log('session_abort',{reason:'离开页面'}); active.current=null; if(owned.current){owned.current=false;void stopExperimentRecording()} }
  },[])
  return <main className="gaze-tetris-page">
    <nav><Link to="/tetris">协作 Tetris（下→静止）</Link> · <Link to="/smr-gaze">← 眼动 SMR 采集</Link> · <Link to={eyeOnly?'/gaze-smr-tetris':'/gaze-tetris'}>{eyeOnly?'眼动 SMR 版':'纯眼动版'}</Link></nav>
    <h1>{eyeOnly?'眼动版':'眼动辅助 SMR'}俄罗斯方块</h1>
    <p>{eyeOnly?'使用已保存的 EEG 眼动 LDA，注视方向即可；无需运动想象。':'REVE＋LP：左手→左移，右手→右移，双手→旋转，休息→下落，同时注视对应方向。'}</p>
    <p>左右二分类模型只控制左右；旋转与下落可用下方按钮。游戏操作单独记录，不当作采集指令标签。</p>
    <LiveEegBadge />
    {!eyeOnly && <ModelHeadPicker task="gaze_smr" disabled={running || busy} />}
    <div className="gaze-game-controls"><label>被试编号 <input value={subject} disabled={running||busy} onChange={e=>setSubject(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={running||busy} onClick={()=>void start()}>开始并录制</button>
      <button className="btn" disabled={!running||busy} onClick={pause}>{paused?'继续':'暂停'}</button>
      <button className="btn" disabled={!running||busy} onClick={()=>void stop()}>结束并保存</button>
      {!running && recorderIsActive() ? <button className="btn" disabled={busy} onClick={()=>void stopExperimentRecording().then(r=>setNotice(r.message))}>保存已有录制</button>:null}
    </div>
    <p role="status">{notice}</p>
    <div className="gaze-game-center"><Board state={game} cell={cell} onCellChange={setCell} /></div>
    <p>得分 {game.score} · 消行 {game.lines}</p>
    <div className="gaze-game-controls">{(['up','down'] as const).map(d=><button className="btn" key={d} disabled={!running||paused} onClick={()=>{const s=active.current;if(s){apply(s,d,'manual');setGame(s.game)}}}>{d==='up'?'旋转':'下落'}</button>)}</div>
  </main>
}
