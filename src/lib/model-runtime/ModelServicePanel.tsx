import { useEffect, useState } from 'react'
import {
  ensureModelService,
  modelServiceStatus,
  stopModelService,
  type ModelServiceBackend,
  type ModelServiceEnsureResult,
} from './modelServiceApi'
import { modelRuntimeHub, modelUrlPresets } from './modelRuntimeHub'
import { REVE_TASKS, reveTaskOption, type ReveTaskId } from './reveTasks'
import { useModelRuntime } from './useModelRuntime'

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
  onReveTaskChange,
}: {
  reveTask?: string
  onReveTaskChange?: (task: ReveTaskId) => void
}) {
  const [busy, setBusy] = useState(false)
  const [proc, setProc] = useState<ModelServiceEnsureResult | null>(null)
  const [launchError, setLaunchError] = useState('')

  const refresh = async (signal?: AbortSignal) => {
    try {
      setProc(await modelServiceStatus(signal))
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

  const afterReady = () => {
    modelRuntimeHub.setEnabled(true)
    modelRuntimeHub.connect()
  }

  const launch = async (backend: ModelServiceBackend, force: boolean) => {
    setBusy(true)
    setLaunchError('')
    try {
      const result = await ensureModelService({
        backend,
        force,
        task: backend === 'reve' ? reveTask : undefined,
      })
      setProc(result)
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
      setProc(await stopModelService())
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
  const canStop = Boolean(proc?.owned && proc.running) && !busy
  const starting = busy || Boolean(proc?.starting)

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {onReveTaskChange ? (
          <label className="acq-field" style={{ minWidth: 220 }}>
            任务头
            <select
              className="input"
              value={reveTask ?? 'passive_rating'}
              disabled={starting}
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
          disabled={starting}
          onClick={() => void launch('reve', occupied || wrongTask)}
        >
          {starting ? '正在启动…' : reveLaunchLabel(reveTask, occupied || wrongTask)}
        </button>
        <button type="button" className="btn" disabled={starting} onClick={() => void launch('mock', occupied)}>
          启动 Mock
        </button>
        <button type="button" className="btn" disabled={!canStop} onClick={() => void stop()}>
          停止
        </button>
        <span className="muted text-sm">
          {starting
            ? `加载中${proc?.backend ? ` · ${proc.backend}` : ''}（REVE 首次可能要一两分钟）`
            : proc?.message || '开发服务可一键拉起本地模型'}
        </span>
      </div>
      {launchError ? (
        <p className="m-0 text-sm" style={{ color: 'var(--danger)' }}>
          {launchError}
        </p>
      ) : null}
      {starting && proc?.logTail ? (
        <pre className="m-0 max-h-28 overflow-auto rounded-lg border border-[var(--border)] bg-[#0a0f18] p-2 text-xs text-[#94a3b8]">
          {proc.logTail.trim()}
        </pre>
      ) : null}
    </div>
  )
}

export function ModelServicePanel({
  embedded = false,
  reveTask,
  onReveTaskChange,
}: {
  embedded?: boolean
  reveTask?: string
  onReveTaskChange?: (task: ReveTaskId) => void
}) {
  const state = useModelRuntime()
  const [url, setUrl] = useState(state.url)
  const [debugOpen, setDebugOpen] = useState(true)
  const prediction = state.latestPrediction

  useEffect(() => {
    setUrl(state.url)
  }, [state.url])

  const body = (
    <>
      <ModelServiceLaunchBar reveTask={reveTask} onReveTaskChange={onReveTaskChange} />
      <div className={`${embedded ? 'flex flex-wrap' : 'acq-bar'} gap-2`} style={{ marginBottom: 8 }}>
        <label className="acq-check">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(event) => modelRuntimeHub.setEnabled(event.target.checked)}
          />
          启用 NCC 模型旁路
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
              modelRuntimeHub.setUrl(url)
              modelRuntimeHub.connect()
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
          会把切窗改成 2s。50M 真模型仍用 <code>MODEL_PACKAGE=...</code> 在终端启动。
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
