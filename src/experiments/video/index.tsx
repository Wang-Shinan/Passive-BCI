import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FeatureMonitorPanel, useFeatureMonitor } from '../../lib/features'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { ModelServicePanel, useModelRuntime } from '../../lib/model-runtime'
import type { ReveTaskId } from '../../lib/model-runtime'
import { SessionLogger } from '../../lib/logger'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { AttentionSpeedControl, calibrateAttentionSpeed, DEFAULT_ATTENTION_SPEED, validAttentionSpeed, VideoSwitchGate, type SwitchSettings } from './control'
import { selectNewVideos, videoFileId } from './playlist'
import { FeatureTrace } from './FeatureTrace'
import { ATTENTION_VOTE_FEATURES, ATTENTION_VOTE_STORAGE, AttentionCalibrationRun, attentionVote, fitAttentionVote, parseAttentionVote,
  type AttentionVoteModel, type CalibrationPhase } from './calibration'
import './video.css'

type Clip = { id: string; name: string; url: string; size: number; modified: number }

export function VideoExperiment() {
  const [clips, setClips] = useState<Clip[]>([])
  const [current, setCurrent] = useState(0)
  const [subject, setSubject] = useState('S01')
  const [theater, setTheater] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [autoNext, setAutoNext] = useState(false)
  const [attentionSpeed, setAttentionSpeed] = useState(false)
  const [speedMode, setSpeedMode] = useState<'raw' | 'vote'>('raw')
  const [boostRate, setBoostRate] = useState(1.5)
  const [voteModel, setVoteModel] = useState<AttentionVoteModel | null>(() => {
    try { return parseAttentionVote(localStorage.getItem(ATTENTION_VOTE_STORAGE)) } catch { return null }
  })
  const [voteFeedback, setVoteFeedback] = useState<ReturnType<typeof attentionVote>>(null)
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const [calibrationView, setCalibrationView] = useState<{ phase: CalibrationPhase | 'ready' | 'error'; remaining: number }>({ phase: 'ready', remaining: 20 })
  const [calibrationNotice, setCalibrationNotice] = useState('')
  const [manualRate, setManualRate] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [attentionScore, setAttentionScore] = useState<number | null>(null)
  const [speedSettings, setSpeedSettings] = useState({ ...DEFAULT_ATTENTION_SPEED })
  const [speedNotice, setSpeedNotice] = useState('')
  const [armed, setArmed] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [task, setTask] = useState<ReveTaskId>('passive_rating')
  const [settings, setSettings] = useState<SwitchSettings>({ confidence: 0.7, confirmations: 3, cooldownMs: 5000 })
  const [notice, setNotice] = useState('导入本机视频开始；实时特征需要在采集页开流。')
  const [error, setError] = useState('')
  const [logger] = useState(() => new SessionLogger('video', 'S01'))
  const video = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const urls = useRef<string[]>([])
  const autoplay = useRef(false)
  const gate = useRef(new VideoSwitchGate())
  const armedAt = useRef(Infinity)
  const lastPrediction = useRef('')
  const speedControl = useRef(new AttentionSpeedControl())
  const calibrationDialog = useRef<HTMLDialogElement>(null)
  const calibrationRun = useRef<AttentionCalibrationRun | null>(null)
  const requestedRate = useRef(1)
  const features = useFeatureMonitor({ preferLive: true, ensureFeatures: ATTENTION_VOTE_FEATURES })
  const eeg = useLiveEeg()
  const model = useModelRuntime()
  const clip = clips[current]
  const classes = model.serviceHello?.class_names ?? model.latestPrediction?.class_names ?? []
  const contract = JSON.stringify([model.latestPrediction?.model_revision ?? model.serviceHello?.model_revision, model.serviceHello?.task, classes])
  const freshSource = eeg.live && eeg.meta.link !== 'demo'
  const calibrationContext = JSON.stringify([subject, eeg.meta.device, eeg.meta.sampleRate, eeg.meta.channelNames, liveEegHub.featureChannelMask()])
  const compatibleVote = voteModel?.context === calibrationContext ? voteModel : null
  const calibrationReady = freshSource && features.origin === 'live' && performance.now() - eeg.lastAt <= 1500
    && !!features.latest && performance.now() - features.latest.t <= 1500
  const speedSource = useRef({ latest: features.latest, live: freshSource && features.origin === 'live', sourceAt: eeg.lastAt, context: calibrationContext })
  speedSource.current = { latest: features.latest, live: freshSource && features.origin === 'live', sourceAt: eeg.lastAt, context: calibrationContext }

  useEffect(() => {
    if (!calibrationOpen) return
    const timer = window.setInterval(() => {
      const run = calibrationRun.current
      if (!run) return
      try {
        const { latest, live, sourceAt, context } = speedSource.current
        if (context !== run.context) throw new Error('被试或采集配置已改变，请重新开始校准。')
        if (document.visibilityState !== 'visible') throw new Error('校准页面已切到后台，请保持弹窗可见并重新开始。')
        const before = run.phase
        const next = run.tick(latest, sourceAt, performance.now(), live)
        setCalibrationView(previous => previous.phase === next.phase && previous.remaining === next.remaining ? previous : next)
        if (before !== next.phase) logger.log('video_attention_calibration_phase', { phase: next.phase })
        if (next.phase === 'done') {
          const fitted = fitAttentionVote(run.rest, run.focus, run.context)
          setVoteModel(fitted)
          try { localStorage.setItem(ATTENTION_VOTE_STORAGE, JSON.stringify(fitted)); setCalibrationNotice('已保存到本机；被试、设备或通道配置改变后需重新校准。') }
          catch { setCalibrationNotice('本次校准已生效，但本机保存失败；刷新后需要重新校准。') }
          logger.log('video_attention_calibration_complete', { model: fitted, rest: run.rest, focus: run.focus })
          calibrationRun.current = null
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logger.log('video_attention_calibration_failed', { message, restCount: run.rest.length, focusCount: run.focus.length })
        calibrationRun.current = null
        setCalibrationNotice(message)
        setCalibrationView({ phase: 'error', remaining: 0 })
      }
    }, 100)
    return () => window.clearInterval(timer)
  }, [calibrationOpen, logger])

  useEffect(() => {
    speedControl.current.reset()
    const update = () => {
      const { latest, live, sourceAt } = speedSource.current
      const eligible = attentionSpeed && playing && !calibrationOpen && live && latest
      const vote = eligible && speedMode === 'vote' && compatibleVote ? attentionVote(latest.values, compatibleVote) : null
      const feedback = speedControl.current.accept(eligible && (speedMode === 'raw' || vote)
        ? { raw: latest.values.focus_score, at: latest.t, sourceAt } : null, performance.now(),
        speedMode === 'raw' ? speedSettings : { ...DEFAULT_ATTENTION_SPEED, minRate: 1, maxRate: boostRate },
        speedMode === 'vote' ? vote?.focused ? boostRate : 1 : undefined)
      const next = calibrationOpen ? 1 : attentionSpeed ? feedback.rate : manualRate
      requestedRate.current = next
      setPlaybackRate(next)
      setAttentionScore(feedback.score)
      setVoteFeedback(feedback.score === null ? null : vote)
      const media = video.current
      if (media && Math.abs(media.playbackRate - next) > .001) {
        media.playbackRate = next
        logger.log('video_playback_rate', { videoId: clip?.id, mediaTime: media.currentTime, rate: next,
          source: calibrationOpen ? 'calibration' : attentionSpeed ? feedback.score === null ? 'fallback' : speedMode : 'manual',
          feature: 'focus_score', score: feedback.score, vote, calibration: speedMode === 'vote' ? compatibleVote?.createdAt : undefined,
          rawFeature: latest?.values.focus_score, featureTime: latest?.t })
      }
    }
    update()
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [attentionSpeed, manualRate, playing, clip?.id, speedSettings, speedMode, boostRate, compatibleVote, calibrationOpen, logger])

  useEffect(() => {
    logger.log('video_speed_control', { enabled: attentionSpeed, mode: speedMode, feature: 'focus_score', manualRate, boostRate,
      calibration: compatibleVote?.createdAt, ...speedSettings })
  }, [attentionSpeed, manualRate, speedSettings, speedMode, boostRate, compatibleVote, logger])

  useEffect(() => { logger.setSubjectId(subject) }, [logger, subject])
  useEffect(() => () => { urls.current.forEach(url => URL.revokeObjectURL(url)) }, [])
  useEffect(() => {
    setArmed(false)
    gate.current.reset()
    setMapping({})
  }, [contract])

  const logPlayback = (type: string, extra: Record<string, unknown> = {}) => {
    logger.log(type, { videoId: clip?.id, videoName: clip?.name, mediaTime: video.current?.currentTime ?? 0, ...extra })
  }
  const selectClip = useCallback((index: number, reason: string, prediction?: Record<string, unknown>) => {
    if (!clips[index] || index === current) return
    autoplay.current = !!video.current && !video.current.paused && !video.current.ended
    if (reason === 'ended') autoplay.current = true
    logger.log('video_switch', {
      from: clips[current]?.id, to: clips[index].id, fromTime: video.current?.currentTime ?? 0,
      reason, prediction, featureOrigin: features.origin, features: features.latest?.values,
    })
    video.current?.pause()
    setPlaying(false)
    setError('')
    setCurrent(index)
    setNotice(`已切换至 ${clips[index].name}（${reason === 'model' ? '模型分类' : reason === 'ended' ? '顺序播放' : '手动'}）`)
  }, [clips, current, logger, features.origin, features.latest])

  useEffect(() => {
    const p = model.latestPrediction
    if (!armed || !playing || !freshSource || model.status !== 'ready' || !model.sourceCompatible) {
      gate.current.suspend()
      armedAt.current = performance.now()
      return
    }
    if (!p || p.received_at_ms <= armedAt.current) return
    const label = gate.current.accept(p, performance.now(), settings)
    if (!label) return
    const target = mapping[label]
    const index = clips.findIndex(item => item.id === target)
    logger.log('video_model_decision', { label, target: target || null, observationId: p.observation_id, modelRevision: p.model_revision, confidence: p.confidence })
    if (index >= 0 && index !== current) selectClip(index, 'model', {
      observationId: p.observation_id, modelRevision: p.model_revision, className: label, confidence: p.confidence,
    })
  }, [armed, playing, freshSource, model.status, model.sourceCompatible, model.latestPrediction, settings, mapping, clips, current, logger, selectClip])

  useEffect(() => {
    if (!playing || !clip || !features.latest || features.origin !== 'live' || !eeg.live) return
    logger.logContext({ type: 'video_features', videoId: clip.id, mediaTime: video.current?.currentTime ?? 0, playbackRate: video.current?.playbackRate ?? 1, featureOrigin: features.origin, featureTime: features.latest.t, values: features.latest.values })
  }, [features.latest, features.origin, eeg.live, playing, clip, logger])

  useEffect(() => {
    const p = model.latestPrediction
    if (!playing || !p || p.observation_id === lastPrediction.current) return
    lastPrediction.current = p.observation_id
    logger.log('video_prediction', { videoId: clip?.id, mediaTime: video.current?.currentTime ?? 0, ...p })
  }, [model.latestPrediction, playing, clip, logger])

  const configure = () => { setArmed(false); gate.current.reset() }
  const importVideos = (files: FileList | null) => {
    if (!files) return
    const { added, duplicates, ignored } = selectNewVideos(Array.from(files), clips.map(item => item.id))
    const next = added.map(file => ({ id: videoFileId(file), name: file.webkitRelativePath || file.name,
      size: file.size, modified: file.lastModified, url: URL.createObjectURL(file) }))
    urls.current.push(...next.map(item => item.url))
    if (next.length) {
      setClips(previous => [...previous, ...next])
      setError('')
      logger.log('video_playlist_append', { clips: next.map(({ url: _url, ...item }) => item), duplicates, ignored })
    }
    setNotice(`新增 ${next.length} 段视频，跳过 ${duplicates} 个重复文件、${ignored} 个非支持格式文件。现有列表与播放进度保留。`)
  }

  const play = async () => {
    try { await video.current?.play(); setError('') }
    catch (e) { setError(`播放失败，请点击播放重试或检查编码：${e instanceof Error ? e.message : String(e)}`) }
  }

  const speedStatus = !attentionSpeed ? '手动控制；选择倍速可随时退出自动调速。'
    : speedMode === 'vote' && !compatibleVote ? '当前被试或采集配置尚未校准，保持 1 倍。'
    : speedMode === 'raw' && !validAttentionSpeed(speedSettings) ? '调速范围无效，已恢复 1 倍。'
    : !playing ? '自动调速已开启，等待视频播放；当前保持 1 倍。'
    : attentionScore === null ? '等待新鲜的真实 EEG 注意力特征；当前保持 1 倍。'
    : speedMode === 'vote' && voteFeedback ? `${voteFeedback.votes} / ${voteFeedback.total} 票 · 至少 ${compatibleVote!.minimumVotes} 票加速 · ${voteFeedback.focused ? `集中，目标 ${boostRate} 倍` : '静止，目标 1 倍'}`
    : `注意力指标 ${attentionScore.toFixed(1)} / 100 · 分数越高，播放越快。`

  return <div className="video-experiment mx-auto max-w-7xl px-4 py-6 sm:px-6">
    <header className="video-header">
      <div><Link to="/" className="muted text-sm">← 实验目录</Link><h1 className="mt-2 text-2xl font-semibold">视频观看与脑电反馈</h1><p className="muted text-sm">观看本机视频，用注意力特征调节倍速，或由分类头选择下一段视频。</p></div>
      <ExportButtons logger={logger} subjectId={subject} onSubjectChange={setSubject} experiment="video" recordControl />
    </header>
    <div className={`video-workspace ${theater ? 'is-theater' : ''}`}>
      <main className="video-main">
        <div ref={stage} className="video-stage">
          {clip ? <video key={clip.id} ref={video} src={clip.url} controls playsInline preload="metadata"
            onLoadedMetadata={() => { if (video.current) video.current.playbackRate = requestedRate.current; logPlayback('video_loaded', { duration: video.current?.duration }); if (autoplay.current) { autoplay.current = false; void play() } }}
            onRateChange={() => {
              const rate = video.current?.playbackRate ?? 1
              if (Math.abs(rate - requestedRate.current) <= .001) return
              requestedRate.current = rate
              setAttentionSpeed(false); setManualRate(rate); setPlaybackRate(rate)
              logPlayback('video_playback_rate', { rate, source: 'native-manual' })
            }}
            onPlaying={() => { setPlaying(true); logPlayback('video_playing') }}
            onPause={() => { setPlaying(false); logPlayback('video_pause') }}
            onSeeking={() => { setPlaying(false); logPlayback('video_seeking'); gate.current.suspend() }}
            onSeeked={() => { setPlaying(!video.current?.paused); logPlayback('video_seeked') }}
            onWaiting={() => { setPlaying(false); logPlayback('video_buffering') }}
            onEnded={() => { setPlaying(false); logPlayback('video_ended'); if (autoNext && current + 1 < clips.length) selectClip(current + 1, 'ended') }}
            onError={() => { setPlaying(false); configure(); setError('视频解码失败。请使用浏览器支持的编码，文件扩展名不保证可播放。'); logPlayback('video_error', { code: video.current?.error?.code }) }}
          /> : <div className="video-empty">导入视频后在这里播放<br /><small>支持浏览器可解码的 MP4、WebM 等格式</small></div>}
        </div>
        <div className="video-transport">
          <button className="btn" disabled={!clip || current === 0} onClick={() => { configure(); selectClip(current - 1, 'manual') }}>上一段</button>
          <button className="btn btn-primary" disabled={!clip} onClick={() => playing ? video.current?.pause() : void play()}>{playing ? '暂停' : '播放'}</button>
          <button className="btn" disabled={!clip || current === clips.length - 1} onClick={() => { configure(); selectClip(current + 1, 'manual') }}>下一段</button>
          <button className="btn" disabled={!clip} onClick={() => { void stage.current?.requestFullscreen().catch(() => setError('无法进入全屏，请检查浏览器设置。')) }}>全屏视频</button>
          <button className="btn" aria-pressed={theater} onClick={() => setTheater(!theater)}>{theater ? '退出专注' : '专注观看'}</button>
          <label><input type="checkbox" checked={autoNext} onChange={e => setAutoNext(e.target.checked)} /> 播完顺序切换</label>
        </div>
        <section className="video-speed" aria-label="注意力控制倍速">
          <div className="video-section-heading"><h2>播放倍速</h2><strong aria-label="当前播放倍速">{playbackRate.toFixed(2)}×</strong></div>
          <div className="video-speed-controls">
            <label><input type="checkbox" checked={attentionSpeed} onChange={e => setAttentionSpeed(e.target.checked)} /> 注意力自动调速</label>
            <label>控制方式<select value={speedMode} onChange={e => setSpeedMode(e.target.value as 'raw' | 'vote')}>
              <option value="raw">原始信号 · 连续调速</option>
              <option value="vote" disabled={!compatibleVote}>校准投票 · 达标加速{compatibleVote ? '' : '（需校准）'}</option>
            </select></label>
            <label>手动倍速<select value={manualRate} onChange={e => { setAttentionSpeed(false); setManualRate(Number(e.target.value)) }}>
              {[...new Set([.5, .75, 1, 1.25, 1.5, 1.75, 2, manualRate])].sort((a, b) => a - b).map(rate => <option key={rate} value={rate}>{rate}×</option>)}
            </select></label>
          </div>
          <p className="muted text-sm" role="status">{speedStatus}</p>
          <div className="video-speed-controls">
            <button className="btn" onClick={() => {
              video.current?.pause(); setPlaying(false)
              calibrationRun.current = null
              setCalibrationView({ phase: 'ready', remaining: 20 }); setCalibrationNotice('')
              setCalibrationOpen(true); calibrationDialog.current?.showModal()
            }}>{compatibleVote ? '重新校准投票' : '校准投票：静止 / 集中'}</button>
            {speedMode === 'vote' && <label>集中时倍速<select value={boostRate} onChange={e => setBoostRate(Number(e.target.value))}>
              {[1.25, 1.5, 1.75, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
            </select></label>}
            {compatibleVote && <span className="muted text-xs">已校准 · {compatibleVote.minimumVotes}/{compatibleVote.rules.length} 票加速 · 后段验证 {(compatibleVote.validation.balancedAccuracy * 100).toFixed(0)}%</span>}
          </div>
          {speedMode === 'raw' && <details className="video-speed-settings"><summary>原始信号范围与近期区间校准</summary>
            <div className="video-speed-grid">
              <label>最低倍速<input type="number" min="0.5" max="2" step="0.05" value={speedSettings.minRate} onChange={e => setSpeedSettings(s => ({ ...s, minRate: Number(e.target.value) }))} /></label>
              <label>最高倍速<input type="number" min="0.5" max="2" step="0.05" value={speedSettings.maxRate} onChange={e => setSpeedSettings(s => ({ ...s, maxRate: Number(e.target.value) }))} /></label>
              <label>低注意力分数<input type="number" min="0" max="100" value={speedSettings.lowScore} onChange={e => setSpeedSettings(s => ({ ...s, lowScore: Number(e.target.value) }))} /></label>
              <label>高注意力分数<input type="number" min="0" max="100" value={speedSettings.highScore} onChange={e => setSpeedSettings(s => ({ ...s, highScore: Number(e.target.value) }))} /></label>
            </div>
            <button className="btn" disabled={!freshSource || features.origin !== 'live'} onClick={() => {
              const range = performance.now() - eeg.lastAt <= 1500 ? calibrateAttentionSpeed(features.history, performance.now()) : null
              if (!range) { setSpeedNotice('需要至少 5 秒有效特征且有足够波动；请继续采集后重试。'); return }
              setSpeedSettings(s => ({ ...s, lowScore: range[0], highScore: range[1] }))
              setSpeedNotice(`已按近期特征校准：${range[0]}–${range[1]}。`)
            }}>用最近 10 秒校准</button>
            {speedNotice && <p className="muted text-sm" role="status">{speedNotice}</p>}
            {!validAttentionSpeed(speedSettings) && <p className="video-error" role="alert">倍速范围须在 0.5–2 之间，最低倍速不能高于最高倍速；注意力分数须在 0–100 之间且下限小于上限。</p>}
            <p className="muted text-xs">使用现有 focus_score，按个人分数区间映射；每秒最多调整 0.1 倍。暂停、断流或特征无效时恢复 1 倍。演示流和曲线预览不参与调速。</p>
          </details>}
          {speedMode === 'vote' && <p className="muted text-xs">达标后平滑加速，未达标回到 1 倍；断流或特征无效立即恢复 1 倍。换电极后请重新校准。</p>}
        </section>
        <p role="status" className="muted text-sm">{notice}</p>
        {error && <p role="alert" className="video-error">{error}</p>}
        <details className="video-library video-disclosure" open><summary>播放列表<span>{clips.length} 段视频</span></summary><div className="video-disclosure-body">
          <label className="video-import">添加视频文件 <input type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.ogv" multiple onChange={e => { importVideos(e.target.files); e.target.value = '' }} /></label>
          <label className="video-import">添加视频文件夹 <input type="file" multiple {...{ webkitdirectory: '' }} onChange={e => { importVideos(e.target.files); e.target.value = '' }} /></label>
          <ol className="video-playlist">{clips.map((item, index) => <li key={item.id}><button className={`btn ${index === current ? 'btn-primary' : ''}`} onClick={() => { configure(); selectClip(index, 'manual') }}>{index + 1}. {item.name}</button></li>)}</ol>
          <p className="muted text-xs">文件和文件夹均追加到列表；文件夹包含子目录，非视频文件自动跳过。重复按相对路径、大小和修改时间判断。刷新页面后需重新选择。</p>
        </div></details>
        <details className="video-disclosure video-monitor" open><summary>EEG 特征监控<span>{eeg.live ? '实时' : '等待连接'}</span></summary><FeatureTrace history={features.history} live={eeg.live} /><details className="video-feature-details"><summary>全部特征与监控配置</summary><FeatureMonitorPanel defaultPickerOpen={false} latest={features.latest} history={features.history} analyzing={features.analyzing && eeg.live} enabledIds={features.enabledIds} onEnabledChange={features.onEnabledChange}
          note={eeg.live ? eeg.meta.link === 'demo' ? '采集页演示流，非真实 EEG；模型自动切换已禁用。' : '实时 EEG 特征与当前视频时间写入会话上下文。' : '等待采集页开流；断流时图表可能保留最后值，不生成模拟特征。'} /></details></details>
      </main>
      <aside className="video-sidebar">
        <section className="video-classification"><div className="video-section-heading"><h2>脑电切换</h2><span>{armed ? '已启用' : '手动'}</span></div>
          <p className="muted text-sm">先在下方连接模型，再把各类别映射到视频。没有映射的类别保持当前视频。</p>
          {classes.map(name => <label className="video-field" key={name}>{name}<select value={mapping[name] ?? ''} onChange={e => { configure(); setMapping(prev => ({ ...prev, [name]: e.target.value })) }}><option value="">不切换</option>{clips.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>)}
          <label className="video-field">最低置信度 {settings.confidence.toFixed(2)}<input type="range" min="0.1" max="1" step="0.05" value={settings.confidence} onChange={e => { configure(); setSettings(s => ({ ...s, confidence: Number(e.target.value) })) }} /></label>
          <label className="video-field">连续确认次数<select value={settings.confirmations} onChange={e => { configure(); setSettings(s => ({ ...s, confirmations: Number(e.target.value) })) }}>{[1, 2, 3, 5, 10].map(n => <option key={n}>{n}</option>)}</select></label>
          <label className="video-field">切换冷却<select value={settings.cooldownMs} onChange={e => { configure(); setSettings(s => ({ ...s, cooldownMs: Number(e.target.value) })) }}>{[2000, 5000, 10000, 30000].map(n => <option key={n} value={n}>{n / 1000} 秒</option>)}</select></label>
          <button className={`btn ${armed ? 'btn-primary' : ''}`} disabled={!armed && (!freshSource || model.status !== 'ready' || !model.sourceCompatible || !Object.values(mapping).some(Boolean))} onClick={() => {
            gate.current.reset(); armedAt.current = performance.now(); setArmed(!armed)
            logger.log('video_model_control', { enabled: !armed, mapping, settings, modelRevision: model.serviceHello?.model_revision })
          }}>{armed ? '关闭模型切换' : '启用模型切换'}</button>
          <p className="muted text-xs">{armed ? playing && freshSource && model.status === 'ready' ? '已启用：仅处理新预测。' : '已启用，等待播放、实时 EEG 与模型就绪。' : '手动模式；需要真实 EEG、模型就绪及至少一个映射。'}</p>
          <p className="muted text-xs">最新分类：{model.latestPrediction?.class_name ?? '—'}。切换依据分类输出，不把频带特征自动解释为情绪或视频内容。</p>
        </section>
        <details className="video-disclosure"><summary>模型与连接设置<span>{model.status === 'ready' ? '已连接' : '未就绪'}</span></summary><div className="video-disclosure-body"><ModelServicePanel embedded reveTask={task} onReveTaskChange={value => { configure(); setTask(value) }} /></div></details>
        <details className="video-disclosure"><summary>采集与记录说明</summary><div className="video-disclosure-body"><p className="muted text-sm">在采集页连接设备，使用本页录制按钮保存 EEG、播放事件与特征。未录制时仅保留有限的浏览器日志，可导出 JSON／CSV。</p><p className="muted text-xs">本页是 visual-video-task 的网页播放适配，不包含其固定 Session、题库、硬件触发或面部录像协议。播放时间为浏览器事件时间，非经硬件验证的刺激 onset。</p></div></details>
      </aside>
    </div>
    <dialog ref={calibrationDialog} className="video-calibration-dialog" aria-labelledby="video-calibration-title" aria-describedby="video-calibration-description"
      onClose={() => {
        if (calibrationRun.current) logger.log('video_attention_calibration_cancelled', { phase: calibrationRun.current.phase })
        calibrationRun.current = null; setCalibrationOpen(false)
      }}>
      <div className="video-section-heading"><h2 id="video-calibration-title">注意力投票校准</h2>
        <button className="btn" onClick={() => calibrationDialog.current?.close()}>关闭</button></div>
      <p id="video-calibration-description" className="muted">保持身体不动、眼睛睁开：先静止 20 秒，再集中注意力 20 秒。校准期间视频暂停。</p>
      {(calibrationView.phase === 'ready' || calibrationView.phase === 'error') && <>
        <ol className="video-calibration-steps">
          <li><strong>静止 · 20 秒</strong><span>自然放松，注视中央十字，不做刻意心算。</span></li>
          <li><strong>准备 · 3 秒</strong><span>保持姿势，等待集中提示。</span></li>
          <li><strong>集中 · 20 秒</strong><span>继续注视十字，默算从 100 开始连续减 7；保持头部和下颌放松。</span></li>
        </ol>
        <p className="muted text-sm">从两段 EEG 特征中选择阈值、方向和所需票数。未达标按 1 倍播放，达标后加速；原始信号控制仍可选。</p>
        {!calibrationReady && <p role="status">等待新鲜的真实 EEG；请先连接设备并开始采集。</p>}
        <button className="btn btn-primary" autoFocus disabled={!calibrationReady} onClick={() => {
          calibrationRun.current = new AttentionCalibrationRun(performance.now(), calibrationContext)
          setCalibrationNotice(''); setCalibrationView({ phase: 'rest', remaining: 20 })
          logger.log('video_attention_calibration_start', { phase: 'rest', context: calibrationContext, secondsPerState: 20 })
        }}>{calibrationView.phase === 'error' ? '重新开始校准' : '开始校准'}</button>
      </>}
      {(['rest', 'prepare', 'focus'] as string[]).includes(calibrationView.phase) && <div className="video-calibration-cue">
        <p role="status" aria-live="polite">{calibrationView.phase === 'rest' ? '静止：自然放松' : calibrationView.phase === 'prepare' ? '准备集中注意力' : '集中：从 100 开始连续减 7'}</p>
        <div className="video-calibration-cross" aria-hidden="true">+</div>
        <strong role="timer" aria-label="本阶段剩余秒数">{calibrationView.remaining}<small> 秒</small></strong>
        <progress aria-label="本阶段进度" max={calibrationView.phase === 'prepare' ? 3 : 20} value={(calibrationView.phase === 'prepare' ? 3 : 20) - calibrationView.remaining} />
        <p className="muted text-sm">保持弹窗可见、身体静止。静止 / 集中有效窗口：{calibrationRun.current?.rest.length ?? 0} / {calibrationRun.current?.focus.length ?? 0}</p>
      </div>}
      {calibrationView.phase === 'done' && compatibleVote && <>
        <p className="video-calibration-result">校准完成 · 至少 {compatibleVote.minimumVotes} / {compatibleVote.rules.length} 票时加速</p>
        <p>后段验证：均衡正确率 {(compatibleVote.validation.balancedAccuracy * 100).toFixed(0)}% · 静止 {(compatibleVote.validation.restRecall * 100).toFixed(0)}% · 集中 {(compatibleVote.validation.focusRecall * 100).toFixed(0)}%</p>
        <p className="muted text-sm">验证窗口：静止 {compatibleVote.validation.restCount} 个、集中 {compatibleVote.validation.focusCount} 个。短时校准结果仅用于本次控制，不代表跨时段效果。</p>
        <details className="video-speed-settings"><summary>查看投票规则</summary><ul>{compatibleVote.rules.map(rule => <li key={rule.feature}>
          {rule.feature} {rule.above ? '≥' : '≤'} {rule.threshold.toPrecision(4)}：投集中 1 票
        </li>)}</ul></details>
        <button className="btn btn-primary" onClick={() => {
          setSpeedMode('vote'); setAttentionSpeed(true); calibrationDialog.current?.close()
        }}>使用校准投票</button>
        <p className="muted text-sm">应用后点击播放继续观看，也可随时切回原始信号。</p>
      </>}
      {calibrationNotice && <p className={calibrationView.phase === 'error' ? 'video-error' : 'muted text-sm'} role={calibrationView.phase === 'error' ? 'alert' : 'status'}>{calibrationNotice}</p>}
    </dialog>
  </div>
}
