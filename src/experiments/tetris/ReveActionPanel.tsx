import { useState } from 'react'
import { ensureModelService } from '../../lib/model-runtime/modelServiceApi'
import { modelRuntimeHub } from '../../lib/model-runtime/modelRuntimeHub'
import { useModelRuntime } from '../../lib/model-runtime/useModelRuntime'
import { ModelServicePanel } from '../../lib/model-runtime/ModelServicePanel'
import { Panel } from '../../lib/ui/Panel'
import {
  TETRIS_ACTION_CLASS_NAMES,
  TETRIS_ACTION_SEMANTICS,
  describeTetrisAction,
  isTetrisActionPrediction,
  tetrisActionFromPrediction,
} from './reveAction'

type Props = {
  disabled?: boolean
  learnEnabled: boolean
  onLearnChange: (enabled: boolean) => void
  controlEnabled: boolean
  onControlChange: (enabled: boolean) => void
  restLabelEnabled: boolean
  onRestLabelChange: (enabled: boolean) => void
  lastLabel: string
  labeledCount: number
}

export function ReveActionPanel({
  disabled = false,
  learnEnabled,
  onLearnChange,
  controlEnabled,
  onControlChange,
  restLabelEnabled,
  onRestLabelChange,
  lastLabel,
  labeledCount,
}: Props) {
  const runtime = useModelRuntime()
  const [ensuring, setEnsuring] = useState(false)
  const [ensureError, setEnsureError] = useState('')
  const prediction = runtime.latestPrediction
  const tetrisHead = prediction != null && isTetrisActionPrediction(prediction)
  const helloTask = runtime.serviceHello?.task
  const wrongHead =
    runtime.status === 'ready' &&
    Boolean(runtime.serviceHello) &&
    helloTask !== 'tetris_action' &&
    prediction?.output_semantics !== TETRIS_ACTION_SEMANTICS

  const startReve = async (force: boolean) => {
    setEnsuring(true)
    setEnsureError('')
    try {
      const result = await ensureModelService({
        backend: 'reve',
        task: 'tetris_action',
        force,
      })
      modelRuntimeHub.setEnabled(true)
      modelRuntimeHub.connect()
      if (result.message) setEnsureError('')
    } catch (error) {
      setEnsureError(error instanceof Error ? error.message : String(error))
    } finally {
      setEnsuring(false)
    }
  }

  const enableLearn = async (enabled: boolean) => {
    onLearnChange(enabled)
    if (!enabled) return
    modelRuntimeHub.setEnabled(true)
    await startReve(false)
  }

  const action = prediction && tetrisHead ? tetrisActionFromPrediction(prediction) : null
  const classNames = tetrisHead ? prediction.class_names : [...TETRIS_ACTION_CLASS_NAMES]
  const probs = tetrisHead ? prediction.probabilities : null
  const peaked =
    probs != null &&
    probs.length > 1 &&
    Math.max(...probs) > 0.9 &&
    (prediction?.online_update_step ?? 0) < 20

  return (
    <Panel title="REVE 操作分类">
      <p className="muted m-0 mb-3 text-sm">
        用键盘玩方块时，把 ←→↻ 等操作标到当前 2 秒 EEG 窗上，只更新冻结 REVE 上的 7 类线性头。未训练时各类应接近均匀；不要让 rest 标得比真实按键还多，否则会塌成只猜一类、置信度顶格。
      </p>
      <label className="acq-check mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={learnEnabled}
          disabled={disabled || ensuring}
          onChange={(event) => void enableLearn(event.target.checked)}
        />
        键盘操作在线学习
      </label>
      <label className="acq-check mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={restLabelEnabled}
          disabled={!learnEnabled}
          onChange={(event) => onRestLabelChange(event.target.checked)}
        />
        无按键时标注 rest（不会多于真实按键；闲置时请关掉）
      </label>
      <label className="acq-check mb-3 flex items-center gap-2">
        <input
          type="checkbox"
          checked={controlEnabled}
          disabled={disabled}
          onChange={(event) => onControlChange(event.target.checked)}
        />
        用预测操控方块（rest 不动作；与 RL 互斥）
      </label>
      {wrongHead ? (
        <p className="mb-3 text-sm" style={{ color: 'var(--warn)' }}>
          当前服务不是方块操作头（{helloTask ?? prediction?.task ?? '未知'}）。
          <button type="button" className="btn ml-2" disabled={ensuring} onClick={() => void startReve(true)}>
            切换到 tetris_action
          </button>
        </p>
      ) : null}
      {ensureError ? (
        <p className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
          {ensureError}
          {ensureError.includes('占用') ? (
            <button type="button" className="btn ml-2" disabled={ensuring} onClick={() => void startReve(true)}>
              强制启动
            </button>
          ) : null}
        </p>
      ) : null}
      {ensuring ? <p className="muted mb-3 text-sm">正在加载 REVE 操作头…</p> : null}

      <div className="mb-3 rounded-xl border border-[var(--border)] bg-[#0f1526] px-3 py-2 text-sm">
        <div className="muted text-xs">当前预测</div>
        <div className="font-mono text-xs">
          {tetrisHead
            ? `${describeTetrisAction(action)} · ${prediction.class_name} ${(prediction.confidence * 100).toFixed(0)}%`
            : '等待 tetris_action_7'}
        </div>
        <div className="muted mt-1 text-xs">
          最近标签 {lastLabel || '—'} · 本页标注 {labeledCount} · 头更新 step{' '}
          {prediction?.online_update_step ?? 0}
        </div>
        {peaked ? (
          <p className="mb-0 mt-2 text-xs" style={{ color: 'var(--warn)' }}>
            置信度顶格且几乎只猜一类。请点「强制启动」加载归一化后的头，并先用键盘打多样按键；rest
            标太多会把头塌掉。
          </p>
        ) : null}
      </div>

      <div className="mb-4 space-y-1">
        {classNames.map((name, index) => {
          const value = probs?.[index] ?? 0
          return (
            <div key={`${name}-${index}`}>
              <div className="mb-0.5 flex justify-between text-xs">
                <span>{describeTetrisAction(name)}</span>
                <span className="muted">{(value * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--panel-2)' }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(0, Math.min(100, value * 100))}%`,
                    background: index === 0 ? 'var(--muted)' : 'var(--accent)',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>

      <ModelServicePanel embedded reveTask="tetris_action" />
    </Panel>
  )
}
