import { Panel } from '../../lib/ui/Panel'
import type { RlModelMetadata } from './rl/contracts'

export interface RlAgentPanelProps {
  enabled: boolean
  onEnabledChange: (value: boolean) => void
  loading: boolean
  loadError: string | null
  metadata: RlModelMetadata | null
  lastAction: string
  latencyMs: number | null
  onLoad: () => void
}

export function RlAgentPanel({
  enabled,
  onEnabledChange,
  loading,
  loadError,
  metadata,
  lastAction,
  latencyMs,
  onLoad,
}: RlAgentPanelProps) {
  return (
    <Panel title="RL Agent（本地 ONNX）">
      <p className="muted m-0 mb-3 text-sm">
        加载 Python 训练导出的 DQN 策略，按固定周期自主控制方块。启用后与键盘/MI 互斥。
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={onLoad} disabled={loading}>
          {loading ? '加载中…' : metadata ? '重新加载模型' : '加载模型'}
        </button>
        <label className="acq-check flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!metadata || loading}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          启用 AI 代打
        </label>
      </div>
      {loadError && (
        <div className="mb-3 rounded-xl border border-[#f55] bg-[#2a1010] px-3 py-2 text-sm text-[#f88]">
          {loadError}
        </div>
      )}
      {metadata && (
        <div className="rounded-xl border border-[var(--border)] bg-[#0f1526] px-3 py-2 text-sm">
          <div className="muted text-xs">模型</div>
          <div className="font-mono text-xs">
            v{metadata.version} · {metadata.trainedSteps ?? '?'} steps
            {metadata.evalMeanLines != null ? ` · eval ${metadata.evalMeanLines.toFixed(1)} lines` : ''}
          </div>
          <div className="muted mt-2 text-xs">最近动作</div>
          <div className="font-mono text-xs">{lastAction}</div>
          {latencyMs != null && (
            <div className="muted mt-1 text-xs">推理 {latencyMs.toFixed(1)} ms</div>
          )}
        </div>
      )}
    </Panel>
  )
}
