import { Panel } from '../../lib/ui/Panel'

export interface RlAgentPanelProps {
  enabled: boolean
  onEnabledChange: (value: boolean) => void
  lastAction: string
  latencyMs: number | null
}

export function RlAgentPanel({ enabled, onEnabledChange, lastAction, latencyMs }: RlAgentPanelProps) {
  return (
    <Panel title="启发式教师（BC 演示）">
      <p className="muted m-0 mb-3 text-sm">
        直接跑训练时克隆的 1-ply 落点启发式，评估约 35 行。不加载神经网络。启用后与键盘/MI 互斥。
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <label className="acq-check flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} />
          启用教师代打
        </label>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[#0f1526] px-3 py-2 text-sm">
        <div className="muted text-xs">策略</div>
        <div className="font-mono text-xs">1-ply heuristic · eval ~35.5 lines</div>
        <div className="muted mt-2 text-xs">最近动作</div>
        <div className="font-mono text-xs">{lastAction}</div>
        {latencyMs != null && <div className="muted mt-1 text-xs">规划 {latencyMs.toFixed(1)} ms</div>}
      </div>
    </Panel>
  )
}
