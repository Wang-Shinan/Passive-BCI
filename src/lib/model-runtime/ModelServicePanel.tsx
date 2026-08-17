import { useEffect, useState } from 'react'
import { modelRuntimeHub, modelUrlPresets } from './modelRuntimeHub'
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

export function ModelServicePanel({ embedded = false }: { embedded?: boolean }) {
  const state = useModelRuntime()
  const [url, setUrl] = useState(state.url)
  const [debugOpen, setDebugOpen] = useState(true)
  const prediction = state.latestPrediction

  useEffect(() => {
    setUrl(state.url)
  }, [state.url])

  const body = (
    <>
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
          若 Vite 代理失败，试「直连 8768」。50M 真模型需{' '}
          <code>MODEL_PACKAGE=... npm run model-service</code>；dev mock 用{' '}
          <code>MODEL_DEVICE_PROFILE=bcigo32|neuracle59</code>。Neuracle/BCIGo 通道布局须与包体
          input_contract 一致，否则只有 hello、无 prediction。
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
