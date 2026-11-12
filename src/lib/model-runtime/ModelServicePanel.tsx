import { useEffect, useRef, useState } from 'react'
import { useLiveEeg } from '../eeg/useLiveEeg'
import type { ModelWeightOption } from './modelServiceTypes'
import {
  ensureModelService,
  modelServiceStatus,
  stopModelService,
  fetchModelHeads,
  selectModelHeadPreference,
  type ModelHeadOption,
  type ModelServiceBackend,
  type ModelServiceEnsureResult,
} from './modelServiceApi'
import { modelRuntimeHub, modelUrlPresets } from './modelRuntimeHub'
import { REVE_TASKS, liveStepSecForReveTask, reveTaskOption, type ReveTaskId } from './reveTasks'
import { useModelRuntime } from './useModelRuntime'
import { HeadSelector } from './HeadSelector'
import { knownS04Revision } from './subjectModels'
import { useModelConfiguration, useAppliedModel } from './useModelConfiguration'

function latency(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)} ms`
}

function socketStateLabel(state: number | null): string {
  if (state == null) return '—'
  if (state === WebSocket.CONNECTING) return 'CONNECTING'
  if (state === WebSocket.OPEN) return 'OPEN'
  if (state === WebSocket.CLOSING) return 'CLOSING'
  if (state === WebSocket.CLOSED) return 'CLOSED'
  return String(state)
}

function formatLogTime(atMs: number): string {
  const d = new Date(atMs)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function reveLaunchLabel(task: string | undefined, force: boolean): string {
  const short = reveTaskOption(task)?.short ?? 'REVE'
  if (force) return task ? `切换/强制启动${short}` : '强制启动 REVE'
  return task ? `启动 ${short}` : '启动 REVE'
}

function ModelServiceLaunchBar({
  reveTask,
  liveStepSec,
  onReveTaskChange,
}: {
  reveTask?: string
  liveStepSec?: number
  onReveTaskChange?: (task: ReveTaskId) => void
}) {
  const [busy, setBusy] = useState(false)
  const [architecture, setArchitecture] = useState<'reve' | 'eegnet'>('reve')
  const [weightId, setWeightId] = useState('')
  const [weights, setWeights] = useState<ModelWeightOption[]>([])
  const [weightError, setWeightError] = useState('')
  const [seed, setSeed] = useState(20261022)
  const [stepSecText, setStepSecText] = useState('')
  const [windowSec, setWindowSec] = useState(2)
  const [eegnetWindow, setEegnetWindow] = useState('')
  const { meta: eegMeta } = useLiveEeg()
  const refreshWeights = async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/model-service/weights', { signal })
      const body = await response.json() as { ok: boolean; weights: ModelWeightOption[]; message?: string }
      if (!response.ok || !body.ok) throw new Error(body.message || '读取权重失败')
      if (!signal?.aborted) { setWeights(body.weights); setWeightError('') }
    } catch (error) { if (!signal?.aborted) setWeightError(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void refreshWeights(controller.signal)
    return () => controller.abort()
  }, [])

  const [details, setDetails] = useState<ModelServiceEnsureResult | null>(null)
  const proc = useAppliedModel()
  const [launchError, setLaunchError] = useState('')
  const [heads, setHeads] = useState<ModelHeadOption[]>([])
  const [headsLoading, setHeadsLoading] = useState(true)
  const [headsError, setHeadsError] = useState('')
  // The panel owns task switching; a page-provided reveTask only seeds it.
  const [internalTask, setInternalTask] = useState<ReveTaskId>((reveTask as ReveTaskId) ?? 'passive_rating')
  useEffect(() => { if (reveTask) setInternalTask(reveTask as ReveTaskId) }, [reveTask])
  const task = internalTask
  const changeTask = (value: ReveTaskId) => { setInternalTask(value); onReveTaskChange?.(value) }
  const { headId: selectedHead, recording, busy: operationBusy } = useModelConfiguration(task)
  const effStepSec = (() => {
    const parsed = Number(stepSecText)
    if (stepSecText.trim() && Number.isFinite(parsed) && parsed > 0) return parsed
    return architecture === 'eegnet' ? 0.1 : liveStepSec ?? liveStepSecForReveTask(task)
  })()
  useEffect(() => { setStepSecText('') }, [task, architecture])
  const taskHeads = heads.filter((head) => head.task === task || !head.task)
  const selectedOption = heads.find((head) => head.id === selectedHead && head.task === task)
  const invalidHead = Boolean(!headsLoading && !headsError && selectedHead && (!selectedOption || !selectedOption.available))
  const refreshHeads = async (signal?: AbortSignal) => {
    setHeadsLoading(true)
    setHeadsError('')
    try {
      const result = await fetchModelHeads(signal)
      if (!signal?.aborted) setHeads(result)
    }
    catch (error) { if (!signal?.aborted) setHeadsError(error instanceof Error ? error.message : String(error)) }
    finally { if (!signal?.aborted) setHeadsLoading(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void refreshHeads(controller.signal)
    return () => controller.abort()
  }, [selectedHead, task])

  const refresh = async (signal?: AbortSignal) => {
    try {
      setDetails(await modelServiceStatus(signal))
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLaunchError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    const ac = new AbortController()
    void refresh(ac.signal)
    const id = window.setInterval(() => {
      void refresh()
    }, 1000)
    return () => {
      ac.abort()
      window.clearInterval(id)
    }
  }, [])

  const afterReady = () => { modelRuntimeHub.setEnabled(true) }

  const launch = async (backend: ModelServiceBackend, force: boolean) => {
    setBusy(true)
    setLaunchError('')
    try {
      const result = await ensureModelService({
        backend,
        force,
        task: backend === 'reve' ? task : backend === 'eegnet' ? 'smr_control' : undefined,
        weightId: backend === 'mock' ? undefined : weightId,
        eegnetChannels: eegMeta.channelNames.length || 32,
        eegnetSeed: seed,
        headId: backend === 'reve' ? selectedHead : undefined,
        stepSec: backend === 'reve' || backend === 'eegnet' ? effStepSec : undefined,
        windowSec:
          backend === 'reve' ? windowSec :
          backend === 'eegnet' && eegnetWindow ? Number(eegnetWindow) : undefined,
      })
      setDetails(result)
      void refreshWeights()
      afterReady()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLaunchError(error instanceof Error ? error.message : String(error))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  // Controller semantics: while the service runs, changing any control re-applies
  // the desired configuration after a short debounce; a stopped service is never auto-started.
  const serviceActive = Boolean(proc?.running || proc?.starting)
  const applyBlocked = Boolean(
    (architecture === 'reve' && (headsLoading || invalidHead)) ||
    (weightId && !weights.some((item) => item.id === weightId && item.backend === architecture)),
  )
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const launchRef = useRef<(force: boolean) => Promise<void>>(async () => {})
  const applyGateRef = useRef({ active: false, blocked: false })
  launchRef.current = (force) => launch(architecture, force)
  applyGateRef.current = { active: serviceActive, blocked: applyBlocked }
  const scheduleApply = () => {
    if (!applyGateRef.current.active || applyGateRef.current.blocked) return
    if (applyTimer.current) clearTimeout(applyTimer.current)
    applyTimer.current = setTimeout(() => { void launchRef.current(false) }, 400)
  }
  useEffect(() => () => {
    if (applyTimer.current) clearTimeout(applyTimer.current)
  }, [])

  const stop = async () => {
    setBusy(true)
    setLaunchError('')
    try {
      setDetails(await stopModelService())
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const occupied = Boolean(proc?.running && !proc.owned)
  const wrongTask = Boolean(
    proc?.backend === 'reve' && proc.task && proc.task !== task,
  )
  const leavePort = Boolean(proc?.proxyPort && proc.proxyPort !== proc.port)
  const forceReplace = !leavePort && (occupied || wrongTask)
  const canStop = Boolean(proc?.owned || proc?.starting || operationBusy || busy)
  const starting = busy || operationBusy || Boolean(proc?.starting)
  const runtime = useModelRuntime()
  const defaultHeadLabel = task === 'smr_control' ? 'LoRA 自带线性头' : '默认配置'
  const loadedId = proc?.headId || ''
  const desiredId = selectedHead || (task === 'gaze_smr' ? 'gaze_smr_active.pt' : '')
  const selectedRevision = knownS04Revision(selectedHead)
  const sameWeights = Boolean(selectedRevision && runtime.serviceHello?.model_revision === selectedRevision)
  const wantedWindow = architecture === 'reve' ? windowSec : architecture === 'eegnet' && eegnetWindow ? Number(eegnetWindow) : null
  const pendingSelection = Boolean(proc?.running && (proc.backend !== architecture || (proc.weightId || '') !== weightId ||
    (wantedWindow != null && proc.windowSec != null && proc.windowSec !== wantedWindow) ||
    (architecture === 'reve' && !sameWeights && (proc.task !== task || desiredId !== loadedId ||
      (selectedOption?.configurationKey && proc.configurationKey && !proc.configurationKey.startsWith(selectedOption.configurationKey))))))
  const runningLabel = !proc?.running ? '未运行' : proc.backend === 'eegnet' ? (proc.modelRevision || 'EEGNet') : sameWeights ? (selectedHead || defaultHeadLabel) : (proc.headId || proc.loadedHead || defaultHeadLabel)

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="acq-field">模型架构<select className="input" value={architecture} onChange={event => { setArchitecture(event.target.value as 'reve' | 'eegnet'); setWeightId(''); scheduleApply() }}>
          <option value="reve">REVE</option><option value="eegnet">EEGNet</option>
        </select></label>
        <label className="acq-field" style={{ minWidth: 220, maxWidth: '100%' }}>模型权重<select className="input" value={weightId} onChange={event => { setWeightId(event.target.value); scheduleApply() }}>
          <option value="">{architecture === 'eegnet' ? '重新随机初始化（不读取旧权重）' : '跟随所选分类头／默认权重'}</option>
          {weights.filter(item => item.backend === architecture).map(item => <option key={item.id} value={item.id}>{item.kind === 'backbone' ? '骨干' : item.kind === 'adapter' ? 'LoRA' : '完整权重'} · {item.name}</option>)}
        </select></label>
        <button className="btn" onClick={() => void refreshWeights()}>刷新权重</button>
        {architecture === 'eegnet' && !weightId && <label className="acq-field">随机种子<input className="input" type="number" min={0} max={4294967295} step={1} value={seed} onChange={event => { setSeed(Number(event.target.value)); scheduleApply() }} /></label>}
        {architecture === 'reve' && <><div style={{ minWidth: 220, maxWidth: '100%' }}>
          <HeadSelector heads={heads} task={task} value={selectedHead} disabled={headsLoading}
            allowCrossTask
            defaultLabel={task === 'gaze_smr' ? '当前激活 gaze 头及其报告' : task === 'smr_control' ? 'LoRA 自带线性头（新被试默认）' : '默认配置'}
            onChange={(value) => {
              try {
                // Picking a head from another task switches the task with it.
                const head = heads.find((item) => item.id === value)
                const targetTask = head?.task && head.task !== task ? head.task : task
                if (targetTask !== task) changeTask(targetTask as ReveTaskId)
                selectModelHeadPreference(targetTask, value)
                setLaunchError(''); scheduleApply()
              }
              catch (error) { setLaunchError(String(error)) }
            }} />
        </div>
        <button className="btn" disabled={headsLoading} onClick={() => void refreshHeads()}>{headsLoading ? '读取中…' : '刷新线性头'}</button>
        <label className="acq-field" style={{ minWidth: 220 }}>
          任务头
          <select
            className="input"
            value={task}
            onChange={(event) => { changeTask(event.target.value as ReveTaskId); scheduleApply() }}
          >
            {REVE_TASKS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        </>}
        <label className="acq-field">步长 (s)<input className="input" type="number" min={0.02} max={4} step={0.05} value={stepSecText || String(effStepSec)} onChange={event => { setStepSecText(event.target.value); scheduleApply() }} /></label>
        {architecture === 'reve' && <label className="acq-field">窗口 (s)<select className="input" value={windowSec} onChange={event => { setWindowSec(Number(event.target.value)); scheduleApply() }}>
          <option value={2}>2</option><option value={4}>4</option>
        </select></label>}
        {architecture === 'eegnet' && <label className="acq-field">窗口 (s)<select className="input" value={eegnetWindow} onChange={event => { setEegnetWindow(event.target.value); scheduleApply() }}>
          <option value="">随权重 checkpoint</option>
          {[1, 2, 3, 4, 6, 8].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>}
        <button
          type="button"
          className="btn btn-primary"
          disabled={applyBlocked}
          onClick={() => void launch(architecture, forceReplace || Boolean(proc?.running) || (architecture === 'eegnet' && !weightId))}
        >
          {starting ? '应用中…' : proc?.running ? '重启并应用当前配置' : architecture === 'eegnet' ? weightId ? '加载 EEGNet 权重' : '初始化 EEGNet' : weightId ? '应用 REVE 权重与分类头' : reveLaunchLabel(task, forceReplace)}
        </button>
        <button type="button" className="btn" onClick={() => void launch('mock', !leavePort && occupied)}>
          启动 Mock
        </button>
        <button type="button" className="btn" disabled={!canStop} onClick={() => void stop()}>
          停止服务（不自动重连）
        </button>
        <span className="muted text-sm">
          {starting
            ? `应用中 · ${architecture}${architecture === 'reve' ? '（首次可能要一两分钟；改动会取代进行中的启动）' : ''}`
            : details?.message || '开发服务可一键拉起本地模型'}
        </span>
      </div>
      <p className="muted m-0 text-xs">已运行：{proc?.backend} / {proc?.weightId || (proc?.backend === 'eegnet' ? '随机初始化' : '默认权重')} / {runningLabel}。待应用：{architecture} / {weightId || (architecture === 'eegnet' ? '重新随机初始化' : selectedHead || defaultHeadLabel)}。{sameWeights ? '当前连接的模型版本与所选分类头相同。' : leavePort ? `页面连接 ${proc?.proxyPort}，${proc?.port} 上的原服务保持运行。` : pendingSelection ? (serviceActive ? '改动应用中将自动重启服务。' : '选择尚未生效；点击应用后切换。') : serviceActive ? '改动会直接应用到运行中的服务。' : '选择后点击启动按钮生效。'}</p>
      {weightError && <p role="alert" className="m-0 text-xs" style={{ color: 'var(--danger)' }}>{weightError}</p>}
      {architecture === 'eegnet' && <p className="muted m-0 text-xs">完整 checkpoint 同时加载编码器和分类器。文件放入 checkpoints/eegnet 或 recordings/.eegnet 后刷新。随机初始化使用当前 EEG 通道数（未连接时为 32），固定种子可复现，不代表已训练的脑控模型。</p>}
      {architecture === 'reve' && <p className="muted m-0 text-xs">可选基座或 LoRA 权重；独立分类头须与编码器配套。基座无配套头时使用未训练头。</p>}
      {recording && <p role="status" className="muted m-0 text-xs">录制中可更换模型：应用时自动保存当前段，切换后从新段开始录制。停止服务会中断脑控，但不会删除数据。</p>}
      {architecture === 'reve' && selectedOption && <p className="muted m-0 text-xs">配套编码器：{selectedOption.encoderId} · {selectedOption.classes} 类。启动时自动匹配。</p>}
      {architecture === 'reve' && !headsLoading && !taskHeads.length && <p className="muted m-0 text-xs">当前任务暂无已保存线性头。将文件放入 recordings/.reve-heads 后刷新列表。</p>}
      {architecture === 'reve' && (headsError || invalidHead) && <p className="m-0 text-xs" style={{ color: 'var(--danger)' }}>{headsError || selectedOption?.reason || '当前任务的列表中未找到所选分类头，请刷新列表或重新选择。'}</p>}
      {architecture === 'reve' && task === 'smr_control' ? (
        <p className="m-0 text-xs" style={{ color: 'var(--warn)' }}>
          SMR 头冻结，不在线微调。光标仍可由 REVE 驱动。
        </p>
      ) : null}
      {launchError ? (
        <p className="m-0 text-sm" style={{ color: 'var(--danger)' }}>
          {launchError}
        </p>
      ) : null}
      {starting && details?.logTail ? (
        <pre className="m-0 max-h-28 overflow-auto rounded-lg border border-[var(--border)] bg-[#0a0f18] p-2 text-xs text-[#94a3b8]">
          {details.logTail.trim()}
        </pre>
      ) : null}
    </div>
  )
}

export function ModelServicePanel({
  embedded = false,
  reveTask,
  liveStepSec,
  onReveTaskChange,
}: {
  embedded?: boolean
  reveTask?: string
  liveStepSec?: number
  onReveTaskChange?: (task: ReveTaskId) => void
}) {
  const state = useModelRuntime()
  const [url, setUrl] = useState(state.url)
  const [debugOpen, setDebugOpen] = useState(false)
  const prediction = state.latestPrediction

  useEffect(() => {
    setUrl(state.url)
  }, [state.url])

  const body = (
    <>
      <ModelServiceLaunchBar
        reveTask={reveTask}
        liveStepSec={liveStepSec}
        onReveTaskChange={onReveTaskChange}
      />
      <div className={`${embedded ? 'flex flex-wrap' : 'acq-bar'} gap-2`} style={{ marginBottom: 8 }}>
        <label className="acq-check">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(event) => modelRuntimeHub.setEnabled(event.target.checked)}
          />
          启用模型服务
        </label>
        <label className="acq-field" style={{ minWidth: 280, flex: '1 1 280px' }}>
          WebSocket
          <input
            className="input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => modelRuntimeHub.setUrl(url)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') modelRuntimeHub.setUrl(url)
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {modelUrlPresets().map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="btn"
              onClick={() => {
                setUrl(preset.url)
                modelRuntimeHub.setUrl(preset.url)
              }}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            disabled={!state.enabled || state.status === 'connecting'}
            onClick={() => {
              void modelRuntimeHub.setUrl(url).then(() => modelRuntimeHub.connect())
            }}
          >
            重新连接
          </button>
          <button
            type="button"
            className="btn"
            disabled={!state.enabled}
            onClick={() => modelRuntimeHub.sendHelloProbe()}
          >
            发送 hello
          </button>
        </div>
        <span className="acq-status">
          {state.status} · WS {socketStateLabel(state.socketReadyState)} · {state.sourceDetail}
        </span>
      </div>

      {state.serviceHello?.warning && <p role="status" style={{ color: 'var(--warn)' }}>{state.serviceHello.warning}</p>}
      <div className={`${embedded ? 'grid gap-2 text-sm' : 'acq-statusbar'}`} style={{ position: 'static' }}>
        <span>
          模型 <strong>{state.serviceHello?.model_name ?? '—'}</strong>
        </span>
        <span>
          任务 <strong>{state.serviceHello?.task ?? prediction?.task ?? '—'}</strong>
        </span>
        <span>
          版本 <strong>{prediction?.model_revision ?? state.serviceHello?.model_revision ?? '—'}</strong>
        </span>
        <span>
          切窗 <strong>{state.windowSec}s / {state.stepSec}s</strong>
        </span>
        <span>
          窗口 <strong>{state.sentWindows}</strong>
        </span>
        <span>
          待发/推理中 <strong>{state.pendingWindows}/{state.inFlightWindows}</strong>
        </span>
        <span>
          丢弃 <strong>{state.droppedWindows}/{state.droppedSourceBatches}</strong>
        </span>
        <span>
          {state.serviceHello?.input_source === 'omni-sdk' ? 'SDK交付→推理' : '预处理与推理'} P50/P95 <strong>{latency(state.p50LatencyMs)} / {latency(state.p95LatencyMs)}</strong>
        </span>
        <span>
          预测{' '}
          <strong>
            {prediction
              ? `${prediction.class_name} ${(prediction.confidence * 100).toFixed(1)}%`
              : '—'}
          </strong>
        </span>
        {state.serviceHello?.follow?.advertised?.[0] ? (
          <span>
            TCP 跟随 <strong>{state.serviceHello.follow.advertised.join(' · ')}</strong>
          </span>
        ) : null}
      </div>

      {state.lastError ? (
        <p className="m-2 text-sm text-red-400">模型服务：{state.lastError}</p>
      ) : null}
      {state.lastCloseCode != null && state.lastCloseCode !== 1000 ? (
        <p className="muted m-2 text-xs">
          上次关闭 code={state.lastCloseCode}
          {state.lastCloseReason ? ` · ${state.lastCloseReason}` : ''}
        </p>
      ) : null}

      <details
        className="m-2"
        open={debugOpen}
        onToggle={(event) => setDebugOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-sm font-medium">连接调试日志</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => modelRuntimeHub.clearDebugLog()}>
            清空日志
          </button>
        </div>
        <pre
          className="mt-2 max-h-48 overflow-auto rounded-lg border border-[var(--border)] bg-[#0a0f18] p-2 text-xs leading-relaxed text-[#cbd5e1]"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {state.debugLog.length
            ? state.debugLog
                .map((entry) => {
                  const prefix =
                    entry.level === 'error' ? 'ERR' : entry.level === 'warn' ? 'WRN' : 'INF'
                  return `[${formatLogTime(entry.at_ms)}] ${prefix} ${entry.message}${
                    entry.detail ? `\n  ${entry.detail}` : ''
                  }`
                })
                .join('\n')
            : '暂无日志。勾选启用后点「重新连接」或切换 URL 预设。'}
        </pre>
        <p className="muted m-0 mt-2 text-xs">
          点「启动 REVE」即可，无需另开终端（需 <code>npm run dev</code>）。代理失败时试「直连 8768」。hello
          会把切窗改成 2s。SMR 头冻结（strategy=none），三类头仍可在线更新。50M 真模型仍用{' '}
          <code>MODEL_PACKAGE=...</code> 在终端启动。
        </p>
      </details>
    </>
  )

  if (embedded) return <div className="space-y-2">{body}</div>

  return (
    <details className="acq-extra" open>
      <summary>基座模型服务 / 在线学习</summary>
      {body}
    </details>
  )
}
