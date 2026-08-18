import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LiveEegBadge } from '../../lib/eeg/LiveEegBadge'
import { SessionLogger } from '../../lib/logger'
import {
  ModelServicePanel,
  classBarColor,
  labelHotkey,
  loadOnlineLearnTask,
  modelRuntimeHub,
  modelServiceStatus,
  rewardForClass,
  reveTaskOption,
  saveOnlineLearnTask,
  useModelRuntime,
  type ReveTaskId,
} from '../../lib/model-runtime'
import { ExportButtons } from '../../lib/ui/ExportButtons'
import { Panel } from '../../lib/ui/Panel'

type LabelHit = {
  t: number
  observationId: string
  label: number
  labelName: string
  pred: string
  applied: boolean | null
  step: number | null
  reason?: string
}

export function OnlineLearnPage() {
  const [subjectId, setSubjectId] = useState('S01')
  const [task, setTask] = useState<ReveTaskId>(loadOnlineLearnTask)
  const runtime = useModelRuntime()
  const loggerRef = useRef(new SessionLogger('online-learn', subjectId))
  const [hits, setHits] = useState<LabelHit[]>([])
  const [notice, setNotice] = useState('')
  const pendingFeedbackRef = useRef<string | null>(null)
  const lastPredRef = useRef('')
  const lastAckRef = useRef('')

  useEffect(() => {
    loggerRef.current.setSubjectId(subjectId)
  }, [subjectId])

  useEffect(() => {
    saveOnlineLearnTask(task)
  }, [task])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const status = await modelServiceStatus(ac.signal)
        if (ac.signal.aborted) return
        if (!status.running) {
          setNotice('选好任务头再点启动。不会自动拉起评分头。')
          return
        }
        modelRuntimeHub.setEnabled(true)
        modelRuntimeHub.connect()
        setNotice(
          status.task
            ? `已连接正在运行的 ${reveTaskOption(status.task)?.short ?? status.task}`
            : '已连接当前模型服务',
        )
      } catch (error) {
        if (ac.signal.aborted) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setNotice(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => ac.abort()
  }, [])

  const prediction = runtime.latestPrediction
  const liveTask = prediction?.task ?? runtime.serviceHello?.task
  const classNames =
    prediction?.class_names ??
    runtime.serviceHello?.class_names ??
    [...(reveTaskOption(liveTask ?? task)?.classNames ?? [])]
  const canLabel =
    runtime.status === 'ready' &&
    prediction != null &&
    classNames.length > 0 &&
    performance.now() - prediction.received_at_ms < 8000

  useEffect(() => {
    const next = runtime.latestPrediction
    if (!next || lastPredRef.current === next.observation_id) return
    lastPredRef.current = next.observation_id
    loggerRef.current.log('foundation_prediction', {
      observationId: next.observation_id,
      classId: next.class_id,
      className: next.class_name,
      confidence: next.confidence,
      probabilities: next.probabilities,
      onlineUpdateStep: next.online_update_step,
      outputSemantics: next.output_semantics,
      task: next.task,
    })
  }, [runtime.latestPrediction])

  useEffect(() => {
    const ack = runtime.lastFeedbackAck
    if (!ack || lastAckRef.current === ack.feedback_id) return
    lastAckRef.current = ack.feedback_id
    loggerRef.current.log('foundation_feedback_ack', {
      feedbackId: ack.feedback_id,
      observationId: ack.observation_id,
      accepted: ack.accepted,
      reason: ack.reason,
      onlineUpdateStep: ack.online_update_step,
      onlineUpdateApplied: ack.online_update_applied,
    })
    setHits((prev) =>
      prev.map((hit) =>
        hit.observationId === ack.observation_id && hit.applied == null
          ? {
              ...hit,
              applied: ack.online_update_applied === true && ack.accepted,
              step: ack.online_update_step ?? hit.step,
              reason: ack.reason,
            }
          : hit,
      ),
    )
    if (pendingFeedbackRef.current === ack.feedback_id) {
      pendingFeedbackRef.current = null
      setNotice(
        ack.accepted && ack.online_update_applied
          ? `已更新任务头 · step ${ack.online_update_step ?? '—'}`
          : `反馈未应用${ack.reason ? `：${ack.reason}` : ''}`,
      )
    }
  }, [runtime.lastFeedbackAck])

  const labelCurrent = (index: number) => {
    const current = modelRuntimeHub.latestObservation(8000)
    const names = current?.class_names ?? classNames
    if (!current || index < 0 || index >= names.length) {
      setNotice('没有可标注的 2 秒窗。先开采集并连上 REVE 服务。')
      return
    }
    const name = names[index] ?? String(index)
    const feedbackId = modelRuntimeHub.submitFeedback({
      observationId: current.observation_id,
      label: index,
      reward: rewardForClass(current.output_semantics, index),
      metadata: {
        experiment: 'online-learn',
        subjectId,
        task: current.task ?? liveTask ?? task,
        className: name,
      },
    })
    if (!feedbackId) {
      setNotice('无法发送反馈：模型 WebSocket 未连接。')
      return
    }
    pendingFeedbackRef.current = feedbackId
    setHits((prev) =>
      [
        {
          t: performance.now(),
          observationId: current.observation_id,
          label: index,
          labelName: name,
          pred: current.class_name,
          applied: null,
          step: current.online_update_step,
        },
        ...prev,
      ].slice(0, 16),
    )
    loggerRef.current.log('label', {
      observationId: current.observation_id,
      label: index,
      className: name,
      pred: current.class_name,
      task: current.task,
      feedbackId,
    })
    setNotice(`已标注「${name}」，等待服务端更新…`)
  }

  const labelCurrentRef = useRef(labelCurrent)
  labelCurrentRef.current = labelCurrent

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }
      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index >= classNames.length) return
      event.preventDefault()
      labelCurrentRef.current(index)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [classNames.length])

  const probs = prediction?.probabilities
  const ageMs = prediction ? performance.now() - prediction.received_at_ms : null
  const labeledCount = useMemo(
    () => hits.filter((hit) => hit.applied === true).length,
    [hits],
  )
  const selected = reveTaskOption(task)
  const running = reveTaskOption(liveTask)
  const mismatch = Boolean(liveTask && task && liveTask !== task)

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-[var(--text)]">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-2 text-2xl font-semibold tracking-tight">基模在线学习</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            采集开流后把 2 秒原始窗送给本地 REVE。冻结编码器，只更新线性头。任务头可切换；标注按钮跟当前
            class_names 走，数字键 1…N。
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <LiveEegBadge />
          <ExportButtons
            logger={loggerRef.current}
            subjectId={subjectId}
            onSubjectChange={setSubjectId}
            experiment="online-learn"
            recordControl
          />
        </div>
      </header>

      <Panel title="模型连接" className="mb-4">
        <p className="muted mt-0 mb-3 text-sm">
          选任务头再启动。已在跑的服务会直接连上，不会改成评分头。评分、SMR、方块操作是三套独立的线性头。
        </p>
        {runtime.serviceHello?.service === 'ncc-dev-mock' ? (
          <p className="mb-3 text-sm" style={{ color: 'var(--warn)' }}>
            当前连的是 dev mock，不是 REVE。点启动会结束占用 8768 的进程并换成 REVE。
          </p>
        ) : null}
        {mismatch ? (
          <p className="mb-3 text-sm" style={{ color: 'var(--warn)' }}>
            当前服务是 {running?.label ?? liveTask}，选择器是 {selected?.label}。要点「切换」才会换头。
          </p>
        ) : null}
        {runtime.lastError ? (
          <p className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
            {runtime.lastError}
          </p>
        ) : null}
        <ModelServicePanel embedded reveTask={task} onReveTaskChange={setTask} />
      </Panel>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="当前窗口"
          actions={
            <span className="muted text-xs">
              {canLabel ? '可标注' : '等待 2 秒窗'}
              {ageMs != null ? ` · ${Math.round(ageMs)} ms 前` : ''}
            </span>
          }
        >
          <div className="mb-4 flex flex-wrap items-end gap-6">
            <div>
              <p className="muted mb-1 text-xs">预测</p>
              <p className="m-0 text-4xl font-semibold tracking-tight">
                {prediction?.class_name ?? '—'}
              </p>
            </div>
            <div>
              <p className="muted mb-1 text-xs">置信度</p>
              <p className="m-0 text-2xl">
                {prediction ? `${(prediction.confidence * 100).toFixed(0)}%` : '—'}
              </p>
            </div>
            <div>
              <p className="muted mb-1 text-xs">在线步数</p>
              <p className="m-0 text-2xl">{prediction?.online_update_step ?? 0}</p>
            </div>
            <div>
              <p className="muted mb-1 text-xs">任务</p>
              <p className="m-0 text-2xl">{liveTask ?? '—'}</p>
            </div>
          </div>

          <div className="space-y-2">
            {classNames.map((name, index) => {
              const value = probs?.[index] ?? 0
              return (
                <div key={`${name}-${index}`}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span>{name}</span>
                    <span className="muted">{(value * 100).toFixed(1)}%</span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full"
                    style={{ background: 'var(--panel-2)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(100, value * 100))}%`,
                        background: classBarColor(index, classNames.length),
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {classNames.map((name, index) => {
              const key = labelHotkey(index)
              return (
                <button
                  key={`${name}-${index}`}
                  type="button"
                  className="btn btn-primary"
                  disabled={!canLabel}
                  onClick={() => labelCurrent(index)}
                >
                  {key ? `${key} · ${name}` : name}
                </button>
              )
            })}
          </div>
          {notice ? <p className="muted mb-0 mt-3 text-sm">{notice}</p> : null}
        </Panel>

        <Panel title="本页统计">
          <p className="muted mt-0 text-sm">
            已应用更新 <strong>{labeledCount}</strong> / 已发送 {hits.length}
          </p>
          <p className="muted text-sm">
            策略 <strong>{runtime.serviceHello?.strategy ?? '—'}</strong>
          </p>
          <p className="muted text-sm">
            语义 <strong>{prediction?.output_semantics ?? '—'}</strong>
          </p>
          <p className="muted text-sm">
            切窗 <strong>{runtime.windowSec}s / {runtime.stepSec}s</strong>
          </p>
          <p className="muted mb-0 text-sm">
            修订 <strong>{prediction?.model_revision ?? runtime.serviceHello?.model_revision ?? '—'}</strong>
          </p>
        </Panel>
      </div>

      <Panel title="标注记录">
        {hits.length === 0 ? (
          <p className="muted mb-0 text-sm">
            还没有标注。等预测出现后按 1…{Math.max(1, classNames.length)}，或点上面的类名。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="muted text-xs">
                <tr>
                  <th className="py-1 font-medium">标签</th>
                  <th className="py-1 font-medium">当时预测</th>
                  <th className="py-1 font-medium">更新</th>
                  <th className="py-1 font-medium">observation</th>
                </tr>
              </thead>
              <tbody>
                {hits.map((hit) => (
                  <tr key={`${hit.observationId}-${hit.t}`}>
                    <td className="py-1">{hit.labelName}</td>
                    <td className="py-1">{hit.pred}</td>
                    <td className="py-1">
                      {hit.applied == null
                        ? '等待'
                        : hit.applied
                          ? `已应用 · ${hit.step ?? '—'}`
                          : hit.reason ?? '未应用'}
                    </td>
                    <td className="muted py-1 font-mono text-xs">{hit.observationId.slice(0, 18)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
