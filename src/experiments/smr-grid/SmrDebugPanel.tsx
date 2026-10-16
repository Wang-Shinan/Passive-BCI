import { useState } from 'react'
import { ModelServicePanel, TemporalFilterControls, type ModelPrediction, type ModelRuntimeSnapshot, type TemporalDecision, type TemporalFilterConfig } from '../../lib/model-runtime'
import { labelIndexForTarget } from '../smr-adapt/labels'
import { GRID_SIGNAL_MAX_AGE_MS, SMR_GRID_STEP_SEC, type DualAxisPolicy, type Point } from './engine'

export type GridDebugFrame = {
  prediction: ModelPrediction | null
  decision: TemporalDecision | null
  logitAxes: Point | null
  actualVelocity: Point
  sampledAt: number
}

const DIRECTIONS = [
  { dir: 'left', label: '左手 ←', color: '#78b6ff' },
  { dir: 'right', label: '右手 →', color: '#77d5aa' },
  { dir: 'up', label: '舌头 ↑', color: '#c9a0ed' },
  { dir: 'down', label: '休息 ↓', color: '#e8bb72' },
] as const
const number = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? value.toFixed(3) : '—'

export function SmrDebugPanel({ frame, runtime, config, onConfigChange, soft, running, source, dualPolicy, drive, correction }: {
  frame: GridDebugFrame; runtime: ModelRuntimeSnapshot; config: TemporalFilterConfig
  onConfigChange: (config: TemporalFilterConfig) => void
  soft: boolean; running: boolean; source: 'smr' | 'dual' | 'keyboard'; drive: Point; correction: Point
  dualPolicy: DualAxisPolicy
}) {
  const [open, setOpen] = useState(false)
  const [serviceOpen, setServiceOpen] = useState(false)
  const dual = source === 'dual'
  const pred = frame.prediction
  const latest = pred ?? runtime.latestPrediction
  const age = latest ? Math.max(0, frame.sampledAt - latest.received_at_ms) : null
  const filteredLabel = config.mode === 'vote' ? '投票占比' : '滤波输出'
  const vectors = [
    { label: source === 'keyboard' ? '键盘方向值' : dual ? '双轴 Logits 方向差' : '四分类胜出方向', value: frame.logitAxes },
    ...(soft ? [{ label: '回推修正量', value: correction }] : []),
    { label: '合成动作（速度倍率前）', value: drive },
    { label: '实际速度（棋盘／秒）', value: frame.actualVelocity },
  ]

  return <details className="smrgrid-debug" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>SMR 调试板 <span>{dual ? dualPolicy === 'simultaneous' ? '左右 / 上下独立输出 · 双轴同时' : '已知轴二分类 · 分轴控制' : '四分类 · 每次单方向 · 模型连接'}</span></summary>
    {open && <div className="smrgrid-debug-content">
      <div className="smrgrid-debug-status">
        <span>{source === 'keyboard' ? '键盘试玩，未使用脑电' : pred ? '有效 SMR 预测' : '无有效 SMR 预测'} · {running ? '任务运行中' : '任务已暂停'}</span>
        <span>连接 {runtime.status} · 步长 {runtime.stepSec.toFixed(2)} s · 预测年龄 {age === null ? '—' : `${Math.round(age)} ms`}</span>
      </div>
      <div className="smrgrid-debug-grid">
        <section aria-label="SMR 四类输出">
          <h2>{dual ? '两组二分类输出' : '四方向输出'}</h2>
          <p className="smrgrid-debug-note">{dual ? dualPolicy === 'simultaneous' ? '左右一组、上下一组，概率各自合计 100%。探索模式会同时采用双轴。' : '左右一组、上下一组，概率各自合计 100%。控制只采用当前指定轴，另一轴输出仅供观察。' : soft ? '软约束采用本次 logits；下方原始概率仅供观察。' : `原始概率与${filteredLabel}对照。`}</p>
          {DIRECTIONS.map(({ dir, label, color }) => {
            const index = pred ? labelIndexForTarget(pred.class_names, dir) : null
            const probability = index !== null ? pred?.probabilities[index] : undefined
            const logit = index !== null && pred ? pred.logits?.[index] ?? Math.log(Math.max(1e-12, probability ?? 0)) : undefined
            const filteredIndex = frame.decision?.classNames.indexOf(dir) ?? -1
            const filtered = !soft && !dual && filteredIndex >= 0 ? frame.decision?.probabilities[filteredIndex] : undefined
            return <div className="smrgrid-debug-class" key={dir}>
              <div><strong>{label}</strong><span>logit {number(logit)}</span><span>{probability === undefined ? '—' : `${(probability * 100).toFixed(1)}%`}</span></div>
              <div className="smrgrid-debug-track" role="meter" aria-label={`${label} 原始概率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={(probability ?? 0) * 100}>
                <i style={{ width: `${Math.max(0, Math.min(100, (probability ?? 0) * 100))}%`, background: color }} />
              </div>
              {!soft && !dual && <div className="smrgrid-debug-filtered"><span>{filteredLabel} {filtered === undefined ? '—' : `${(filtered * 100).toFixed(1)}%`}</span><div className="smrgrid-debug-track"><i style={{ width: `${Math.max(0, Math.min(100, (filtered ?? 0) * 100))}%`, background: color }} /></div></div>}
            </div>
          })}
          <p className="smrgrid-debug-note">{pred ? pred.logits ? 'Logits：模型原始输出。' : '模型未提供 logits，显示 log(概率)。' : `未连接、输出不符或超过 ${GRID_SIGNAL_MAX_AGE_MS} ms 未更新时，控制停止。`}</p>
          {!soft && !dual && frame.decision?.ready === false && <p className="smrgrid-debug-note">滤波证据尚未就绪，目前不输出动作。</p>}
        </section>
        <section aria-label="SMR 控制診斷">
          <h2>控制診斷</h2>
          <table className="smrgrid-debug-vectors"><thead><tr><th>阶段</th><th>水平 →</th><th>垂直 ↑</th></tr></thead><tbody>
            {vectors.map(({ label, value }) => <tr key={label}><th>{label}</th><td>{number(value?.x)}</td><td>{number(value ? -value.y : undefined)}</td></tr>)}
          </tbody></table>
          <h2>时间滤波</h2>{dual && <p className="smrgrid-debug-note">双轴直接使用各自的 logits，不使用四分类投票或四分类概率滤波。</p>}
          {soft && !dual && <p className="smrgrid-debug-note">软约束直接叠加每次 logits 与回推量；以下滤波设置仅用于自由／硬约束模式。</p>}
          <fieldset disabled={dual || soft || source === 'keyboard'} className="smrgrid-debug-filter">
            <TemporalFilterControls config={config} onChange={onConfigChange} compact />
          </fieldset>
        </section>
      </div>
      <details className="smrgrid-debug-service" open={serviceOpen} onToggle={e => { e.stopPropagation(); setServiceOpen(e.currentTarget.open) }}>
        <summary>模型与连接设置 <span>{dual ? 'S04 · 两个独立二分类模型' : '沿用俄罗斯方块调试板'}</span></summary>
        {serviceOpen && <div className="smrgrid-debug-service-body">{dual ? <div><p>独立服务：ws://127.0.0.1:8769/v1/model</p><p>实际连接：{runtime.url}</p><p>4 秒窗口 · 每 {runtime.stepSec.toFixed(2)} 秒更新 · 左右／上下同步输出</p><p>S04 左右／上下二分类权重 · 固定 0.1 秒滑窗步长</p><p>服务未启动时，在 Passive-BCI 目录执行：</p><code>powershell -ExecutionPolicy Bypass -File scripts/start-smr-dual-axis.ps1</code><p>选择双轴模式时，会自动结束并保存当前录制，再连接模型。已录数据保留。</p></div> : <ModelServicePanel embedded reveTask="smr_control" liveStepSec={SMR_GRID_STEP_SEC} />}</div>}
      </details>
    </div>}
  </details>
}
