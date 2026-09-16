import { useEffect, useState } from 'react'
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
  const [details, setDetails] = useState<ModelServiceEnsureResult | null>(null)
  const proc = useAppliedModel()
  const [launchError, setLaunchError] = useState('')
  const [heads, setHeads] = useState<ModelHeadOption[]>([])
  const [headsLoading, setHeadsLoading] = useState(false)
  const [headsError, setHeadsError] = useState('')
  const task = reveTask ?? 'passive_rating'
  const { headId: selectedHead, recording, busy: operationBusy } = useModelConfiguration(task)
  const taskHeads = heads.filter((head) => head.task === task || !head.task)
  const selectedOption = heads.find((head) => head.id === selectedHead && head.task === task)
  const invalidHead = Boolean(selectedHead && (!selectedOption || !selectedOption.available))
  const refreshHeads = async (signal?: AbortSignal) => {
    setHeadsLoading(true)
    setHeadsError('')
    try { setHeads(await fetchModelHeads(signal)) }
    catch (error) { if (!signal?.aborted) setHeadsError(error instanceof Error ? error.message : String(error)) }
    finally { if (!signal?.aborted) setHeadsLoading(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void refreshHeads(controller.signal)
    return () => controller.abort()
  }, [])

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
        task: backend === 'reve' ? reveTask : undefined,
        headId: backend === 'reve' ? selectedHead : undefined,
        stepSec: backend === 'reve' ? (liveStepSec ?? liveStepSecForReveTask(reveTask)) : undefined,
      })
      setDetails(result)
      afterReady()
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

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
    reveTask && proc?.backend === 'reve' && proc.task && proc.task !== reveTask,
  )
  const canStop = Boolean(proc?.owned || proc?.starting || operationBusy || busy)
  const starting = busy || operationBusy || Boolean(proc?.starting)
  const loadedId = proc?.headId || ''
  const desiredId = selectedHead || (task === 'gaze_smr' ? 'gaze_smr_active.pt' : '')
  const pendingSelection = Boolean(proc?.running && (proc.task !== task || desiredId !== loadedId || (selectedOption?.configurationKey && selectedOption.configurationKey !== proc.configurationKey)))

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div style={{ minWidth: 220, maxWidth: '100%' }}>
          <HeadSelector heads={heads} task={task} value={selectedHead} disabled={recording || starting || headsLoading}
            defaultLabel={task === 'gaze_smr' ? '当前激活 gaze 头及其报告' : '默认配置'}
            onChange={(value) => {
              try { selectModelHeadPreference(task, value); setLaunchError('') }
              catch (error) { setLaunchError(String(error)) }
            }} />
        </div>
        <button className="btn" disabled={recording || starting || headsLoading} onClick={() => void refreshHeads()}>{headsLoading ? '读取中…' : '刷新线性头'}</button>
        {onReveTaskChange ? (
          <label className="acq-field" style={{ minWidth: 220 }}>
            任务头
            <select
              className="input"
              value={reveTask ?? 'passive_rating'}
              disabled={recording || starting}
              onChange={(event) => onReveTaskChange(event.target.value as ReveTaskId)}
            >
              {REVE_TASKS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={recording || starting || headsLoading || invalidHead}
          onClick={() => void launch('reve', occupied || wrongTask)}
        >
          {starting ? '正在启动…' : pendingSelection ? '应用线性头并重启' : reveLaunchLabel(reveTask, occupied || wrongTask)}
        </button>
        <button type="button" className="btn" disabled={recording || starting} onClick={() => void launch('mock', occupied)}>
          启动 Mock
        </button>
        <button type="button" className="btn" disabled={!canStop} onClick={() => void stop()}>
          停止服务（不自动重连）
        </button>
        <span className="muted text-sm">
          {starting
            ? `加载中${proc?.backend ? ` · ${proc.backend}` : ''}（REVE 首次可能要一两分钟）`
            : details?.message || '开发服务可一键拉起本地模型'}
        </span>
      </div>
      <p className="muted m-0 text-xs">已运行：{proc?.running ? proc?.headId || proc?.loadedHead || '默认模型' : '未运行'}。待应用：{selectedHead || '默认配置'}。{pendingSelection ? '选择尚未生效；点击应用后切换。' : '选择后点击启动按钮生效。'}</p>
      {recording && <p role="status" className="muted m-0 text-xs">录制中：任务、模型和连接地址已锁定。停止服务会中断脑控，但不会删除录制。</p>}
      {selectedOption && <p className="muted m-0 text-xs">配套编码器：{selectedOption.encoderId} · {selectedOption.classes} 类。启动时自动匹配。</p>}
      {!headsLoading && !taskHeads.length && <p className="muted m-0 text-xs">当前任务暂无已保存线性头。将文件放入 recordings/.reve-heads 后刷新列表。</p>}
      {(headsError || invalidHead) && <p className="m-0 text-xs" style={{ color: 'var(--danger)' }}>{headsError || selectedOption?.reason || '所选线性头不可用，请重新选择。'}</p>}
      {reveTask === 'smr_control' ? (
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
  const { recording, busy: operationBusy } = useModelConfiguration(reveTask ?? 'passive_rating')
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
            disabled={!state.enabled && (recording || operationBusy)}
            onChange={(event) => modelRuntimeHub.setEnabled(event.target.checked)}
          />
          启用 NCC 模型旁路
        </label>
        <label className="acq-field" style={{ minWidth: 280, flex: '1 1 280px' }}>
          WebSocket
          <input
            className="input"
            value={url}
            disabled={recording || operationBusy}
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
              disabled={recording || operationBusy}
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
            disabled={operationBusy || !state.enabled || state.status === 'connecting' || (recording && url !== state.url)}
            onClick={() => {
              modelRuntimeHub.setUrl(url)
              modelRuntimeHub.connect()
            }}
          >
            重新连接
          </button>
          <button
            type="button"
            className="btn"
            disabled={operationBusy || !state.enabled}
            onClick={() => modelRuntimeHub.sendHelloProbe()}
          >
            发送 hello
          </button>
        </div>
        <span className="acq-status">
          {state.status} · WS {socketStateLabel(state.socketReadyState)} · {state.sourceDetail}
        </span>
      </div>

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
          P50/P95 <strong>{latency(state.p50LatencyMs)} / {latency(state.p95LatencyMs)}</strong>
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
