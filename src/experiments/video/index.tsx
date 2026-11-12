import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FeatureMonitorPanel, SignalModeControls, useFeatureMonitor, useStressControl } from '../../lib/features'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import { ModelServicePanel, useModelRuntime } from '../../lib/model-runtime'
import type { ReveTaskId } from '../../lib/model-runtime'
import { SessionLogger } from '../../lib/logger'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { VideoSwitchGate, type SwitchDecisionMode, type SwitchSettings } from './control'
import { useVideoRateControl } from './useVideoRateControl'
import { RateCalibrate, type CalibStats } from './RateCalibrate'
import { selectNewVideos, videoFileId } from './playlist'
import { FeatureTrace } from './FeatureTrace'
import './video.css'

type Clip = { id: string; name: string; url: string; size: number; modified: number }

const PLAYBACK_ACTIONS = [
  { id: 'prev', label: '上一段' },
  { id: 'next', label: '下一段' },
  { id: 'pause', label: '暂停' },
  { id: 'play', label: '播放' },
] as const

export function VideoExperiment() {
  const [clips, setClips] = useState<Clip[]>([])
  const [current, setCurrent] = useState(0)
  const [subject, setSubject] = useState('S01')
  const [theater, setTheater] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [autoNext, setAutoNext] = useState(false)
  const [armed, setArmed] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [task, setTask] = useState<ReveTaskId>('passive_rating')
  const [settings, setSettings] = useState<SwitchSettings>({ confidence: 0.7, confirmations: 3, cooldownMs: 5000, mode: 'streak', voteWindow: 5, voteFraction: 0.6 })
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
  const features = useFeatureMonitor({ preferLive: true })
  const {
    mode: rateMode, setMode: setRateMode,
    driverFeature: rateDriver, setDriverFeature: setRateDriver,
    rangeMap: rateRangeMap, setRangeMap: setRateRangeMap,
    resetRangeMap: resetRateRangeMap, captureRangeFromWindow: captureRateRange,
    rangePreview: rateRangePreview,
    stress: focusControl, setStress: setFocusControl,
  } = useStressControl({
    initial: 50,
    defaultDriver: 'focus_score',
    driverStorageKey: 'passive-bci.video-rate-driver',
  })
  const [rateControlOn, setRateControlOn] = useState(false)
  const [calibOpen, setCalibOpen] = useState(false)
  const [controlMode, setControlMode] = useState<'continuous' | 'threshold'>('continuous')
  const [focusThreshold, setFocusThreshold] = useState(50)
  const [minRate, setMinRate] = useState(0.5)
  const [maxRate, setMaxRate] = useState(2)
  const eeg = useLiveEeg()
  const model = useModelRuntime()
  const clip = clips[current]
  const classes = model.serviceHello?.class_names ?? model.latestPrediction?.class_names ?? []
  const contract = JSON.stringify([model.latestPrediction?.model_revision ?? model.serviceHello?.model_revision, model.serviceHello?.task, classes])
  const freshSource = eeg.live && eeg.meta.link !== 'demo'

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
    const action = mapping[label] || null
    logger.log('video_model_decision', { label, action, observationId: p.observation_id, modelRevision: p.model_revision, confidence: p.confidence })
    const pred = { observationId: p.observation_id, modelRevision: p.model_revision, className: label, confidence: p.confidence }
    if (action === 'prev') selectClip(current - 1, 'model', pred)
    else if (action === 'next') selectClip(current + 1, 'model', pred)
    else if (action === 'pause') video.current?.pause()
    else if (action === 'play') void play()
  }, [armed, playing, freshSource, model.status, model.sourceCompatible, model.latestPrediction, settings, mapping, clips, current, logger, selectClip])

  useEffect(() => {
    if (!playing || !clip || !features.latest || features.origin !== 'live' || !eeg.live) return
    logger.logContext({ type: 'video_features', videoId: clip.id, mediaTime: video.current?.currentTime ?? 0, featureOrigin: features.origin, featureTime: features.latest.t, values: features.latest.values })
  }, [features.latest, features.origin, eeg.live, playing, clip, logger])

  useEffect(() => {
    const p = model.latestPrediction
    if (!playing || !p || p.observation_id === lastPrediction.current) return
    lastPrediction.current = p.observation_id
    logger.log('video_prediction', { videoId: clip?.id, mediaTime: video.current?.currentTime ?? 0, ...p })
  }, [model.latestPrediction, playing, clip, logger])

  // Subject focus (control channel) → playbackRate. targetRate is derived from
  // this render; the hook's single 80ms loop eases the live playbackRate toward
  // it (and keeps defaultPlaybackRate aligned so media (re)loads land on it) so
  // feature ticks don't cause audible jumps.
  const { targetRate, appliedRate } = useVideoRateControl({
    video,
    enabled: rateControlOn,
    controlMode,
    control: focusControl,
    threshold: focusThreshold,
    minRate,
    maxRate,
    outMin: rateRangeMap.outMin,
    outMax: rateRangeMap.outMax,
    driver: rateDriver,
    mode: rateMode,
    onSettled: info => {
      logger.logContext({ type: 'video_rate', videoId: clip?.id, mediaTime: info.mediaTime, rate: info.rate, target: info.target, control: info.control, driver: info.driver, mode: info.mode })
    },
  })

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

  return <div className="video-experiment mx-auto max-w-7xl px-4 py-6 sm:px-6">
    <header className="video-header">
      <div><Link to="/" className="muted text-sm">← 实验目录</Link><h1 className="mt-2 text-2xl font-semibold">视频观看与脑电反馈</h1><p className="muted text-sm">观看本机视频，监控 EEG 特征，由分类头选择下一段视频。</p></div>
      <ExportButtons logger={logger} subjectId={subject} onSubjectChange={setSubject} experiment="video" recordControl />
    </header>
    <div className={`video-workspace ${theater ? 'is-theater' : ''}`}>
      <main className="video-main">
        <div ref={stage} className="video-stage">
          {clip ? <video key={clip.id} ref={video} src={clip.url} controls playsInline preload="metadata"
            onLoadedMetadata={() => { logPlayback('video_loaded', { duration: video.current?.duration }); if (autoplay.current) { autoplay.current = false; void play() } }}
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
          <p className="muted text-sm">先在下方连接模型，再把各类别映射到播放动作。未映射的类别不动作。</p>
          {classes.map(name => <label className="video-field" key={name}>{name}<select value={mapping[name] ?? ''} onChange={e => { configure(); setMapping(prev => ({ ...prev, [name]: e.target.value })) }}><option value="">不切换</option>{PLAYBACK_ACTIONS.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}</select></label>)}
          {!classes.length && <p className="muted text-xs">映射类别来自当前运行分类头的 class_names；连接模型服务后自动列出，换头/换任务会重置映射。</p>}
          {!clips.length && <p className="muted text-xs">「上一段/下一段」需要先在左侧播放列表导入视频；「暂停/播放」立即可用。</p>}
          <label className="video-field">判定方式<select value={settings.mode ?? 'streak'} onChange={e => { configure(); setSettings(s => ({ ...s, mode: e.target.value as SwitchDecisionMode })) }}>
            <option value="streak">连续确认</option>
            <option value="vote">多数投票</option>
            <option value="direct">裸连直切</option>
          </select></label>
          <label className="video-field">最低置信度 {settings.confidence.toFixed(2)}<input type="range" min="0.1" max="1" step="0.05" value={settings.confidence} onChange={e => { configure(); setSettings(s => ({ ...s, confidence: Number(e.target.value) })) }} /></label>
          {(settings.mode ?? 'streak') === 'streak' && <label className="video-field">连续确认次数<select value={settings.confirmations} onChange={e => { configure(); setSettings(s => ({ ...s, confirmations: Number(e.target.value) })) }}>{[1, 2, 3, 5, 10].map(n => <option key={n}>{n}</option>)}</select></label>}
          {settings.mode === 'vote' && <>
            <label className="video-field">投票窗口（最近 N 次预测）<select value={settings.voteWindow ?? 5} onChange={e => { configure(); setSettings(s => ({ ...s, voteWindow: Number(e.target.value) })) }}>{[3, 5, 7, 10, 15].map(n => <option key={n}>{n}</option>)}</select></label>
            <label className="video-field">通过比例 {(settings.voteFraction ?? 0.6).toFixed(2)}<input type="range" min={0.34} max={1} step={0.01} value={settings.voteFraction ?? 0.6} onChange={e => { configure(); setSettings(s => ({ ...s, voteFraction: Number(e.target.value) })) }} /></label>
          </>}
          <label className="video-field">切换冷却<select value={settings.cooldownMs} onChange={e => { configure(); setSettings(s => ({ ...s, cooldownMs: Number(e.target.value) })) }}>{[2000, 5000, 10000, 30000].map(n => <option key={n} value={n}>{n / 1000} 秒</option>)}</select></label>
          <button className={`btn ${armed ? 'btn-primary' : ''}`} disabled={!armed && (!freshSource || model.status !== 'ready' || !model.sourceCompatible || !Object.values(mapping).some(Boolean))} onClick={() => {
            gate.current.reset(); armedAt.current = performance.now(); setArmed(!armed)
            logger.log('video_model_control', { enabled: !armed, mapping, settings, modelRevision: model.serviceHello?.model_revision })
          }}>{armed ? '关闭模型切换' : '启用模型切换'}</button>
          <p className="muted text-xs">{armed ? playing && freshSource && model.status === 'ready' ? '已启用：仅处理新预测。' : '已启用，等待播放、实时 EEG 与模型就绪。' : '手动模式；需要真实 EEG、模型就绪及至少一个映射。'}</p>
          <p className="muted text-xs">最新分类：{model.latestPrediction?.class_name ?? '—'}。切换依据分类输出，不把频带特征自动解释为情绪或视频内容。</p>
        </section>
        <section className="video-classification"><div className="video-section-heading"><h2>专注度控速</h2><span>{rateControlOn ? `${appliedRate.toFixed(2)}×` : '关闭'}</span></div>
          <p className="muted text-sm">所选 EEG 特征实时映射为播放倍速。默认驱动 focus_score（β/(α+θ)），可在下方更换。</p>
          <SignalModeControls
            mode={rateMode}
            onModeChange={setRateMode}
            driverFeature={rateDriver}
            preferredDriver="focus_score"
            onDriverChange={setRateDriver}
            rangeMap={rateRangeMap}
            onRangeMapChange={setRateRangeMap}
            onRangeReset={resetRateRangeMap}
            onRangeCapture={captureRateRange}
            rangePreview={rateRangePreview}
          />
          {rateMode === 'manual' && <label className="video-field">专注度 {focusControl.toFixed(0)}<input type="range" min={0} max={100} step={1} value={focusControl} onChange={e => setFocusControl(Number(e.target.value))} /></label>}
          <label className="video-field">控制方式<select value={controlMode} onChange={e => setControlMode(e.target.value as 'continuous' | 'threshold')}>
            <option value="continuous">连续映射（平滑控速）</option>
            <option value="threshold">阈值倍速（低于 1× / 达到 2×）</option>
          </select></label>
          {controlMode === 'threshold' && <label className="video-field">专注阈值 {focusThreshold.toFixed(0)}<input type="range" min={0} max={100} step={1} value={focusThreshold} onChange={e => setFocusThreshold(Number(e.target.value))} /></label>}
          {controlMode === 'continuous' && <>
            <label className="video-field">最低倍速 {minRate.toFixed(2)}×<input type="range" min={0.25} max={1} step={0.05} value={minRate} onChange={e => setMinRate(Number(e.target.value))} /></label>
            <label className="video-field">最高倍速 {maxRate.toFixed(2)}×<input type="range" min={1} max={3} step={0.05} value={maxRate} onChange={e => setMaxRate(Number(e.target.value))} /></label>
          </>}
          <div className="flex gap-2">
            <button className={`btn ${rateControlOn ? 'btn-primary' : ''}`} onClick={() => {
              const next = !rateControlOn
              setRateControlOn(next)
              logger.log('video_rate_control', { enabled: next, controlMode, mode: rateMode, driver: rateDriver, minRate, maxRate, focusThreshold })
            }}>{rateControlOn ? '关闭专注控速' : '启用专注控速'}</button>
            <button className="btn" onClick={() => setCalibOpen(true)}>阈值校准</button>
          </div>
          {!rateControlOn && <p className="muted text-xs">未启用：倍速不受控制。点击上方「启用专注控速」开始。</p>}
          {rateControlOn && (controlMode === 'continuous'
            ? <p className="muted text-xs">控制值 {focusControl.toFixed(0)}（按输出区间 {rateRangeMap.outMin}–{rateRangeMap.outMax} 归一）→ 目标 {targetRate.toFixed(2)}× · 实际 {appliedRate.toFixed(2)}×（{minRate.toFixed(2)}–{maxRate.toFixed(2)}× 线性映射）。关闭时恢复 1×；暂停时倍速保留但不生效。</p>
            : <p className="muted text-xs">控制值 {focusControl.toFixed(0)} {focusControl >= focusThreshold ? '≥' : '&lt;'} 阈值 {focusThreshold.toFixed(0)} → 目标 {targetRate.toFixed(2)}× · 实际 {appliedRate.toFixed(2)}×（低于阈值 1×、达到或高于阈值 2×，无回差）。倍速改动不影响手动暂停/播放，也不会自动续播；关闭时恢复 1×。</p>)}
        </section>
        <details className="video-disclosure"><summary>模型与连接设置<span>{model.status === 'ready' ? '已连接' : '未就绪'}</span></summary><div className="video-disclosure-body"><ModelServicePanel embedded reveTask={task} onReveTaskChange={value => { configure(); setTask(value) }} /></div></details>
        <details className="video-disclosure"><summary>采集与记录说明</summary><div className="video-disclosure-body"><p className="muted text-sm">在采集页连接设备，使用本页录制按钮保存 EEG、播放事件与特征。未录制时仅保留有限的浏览器日志，可导出 JSON／CSV。</p><p className="muted text-xs">本页是 visual-video-task 的网页播放适配，不包含其固定 Session、题库、硬件触发或面部录像协议。播放时间为浏览器事件时间，非经硬件验证的刺激 onset。</p></div></details>
      </aside>
    </div>
    {calibOpen && <RateCalibrate
      driver={rateDriver}
      latest={features.latest}
      onApply={(inMin, inMax, stats: CalibStats) => {
        setRateRangeMap({ ...rateRangeMap, inMin, inMax })
        logger.log('video_rate_calibrate', { driver: rateDriver, inMin, inMax, ...stats })
      }}
      onClose={() => setCalibOpen(false)}
    />}
  </div>
}
