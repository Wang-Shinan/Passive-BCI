import { Panel } from '../../lib/ui/Panel'
import { Slider } from '../../lib/ui/Slider'
import {
  FOLLOW_MOVES_MAX,
  FOLLOW_MOVES_MIN,
  FOLLOW_STEPS_MAX,
  FOLLOW_STEPS_MIN,
} from './collab'

export interface RlAgentPanelProps {
  enabled: boolean
  onEnabledChange: (value: boolean) => void
  collabEnabled: boolean
  onCollabChange: (value: boolean) => void
  followEnabled: boolean
  onFollowChange: (value: boolean) => void
  followMoves: number
  onFollowMovesChange: (value: number) => void
  followSteps: number
  onFollowStepsChange: (value: number) => void
  followHumanCount: number
  lastAction: string
  latencyMs: number | null
}

export function RlAgentPanel({
  enabled,
  onEnabledChange,
  collabEnabled,
  onCollabChange,
  followEnabled,
  onFollowChange,
  followMoves,
  onFollowMovesChange,
  followSteps,
  onFollowStepsChange,
  followHumanCount,
  lastAction,
  latencyMs,
}: RlAgentPanelProps) {
  const strategy = followEnabled
    ? `follow · human ${followHumanCount}/${followMoves} L/R · teacher ${followSteps} L/R · rotate free`
    : collabEnabled
      ? 'current column · I flat unless well'
      : '1-ply heuristic · eval ~35.5 lines'

  return (
    <Panel title="启发式教师（BC 演示）">
      <p className="muted m-0 mb-3 text-sm">
        直接跑训练时克隆的 1-ply 落点启发式。教师代打时与键盘/SMR 互斥。协作按当前列旋转：I
        只在已有深井时才竖放。跟手模式按回合配额：人左右 m 次后，教师立刻走 n
        步左右（不含硬降）。旋转不占用 m/n。
      </p>
      <div className="mb-3 flex flex-col gap-2">
        <label className="acq-check flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          启用教师代打
        </label>
        <label className="acq-check flex items-center gap-2">
          <input
            type="checkbox"
            checked={collabEnabled}
            onChange={(e) => onCollabChange(e.target.checked)}
          />
          人机协作：脑控左右 · 教师旋转
        </label>
        <label className="acq-check flex items-center gap-2">
          <input
            type="checkbox"
            checked={followEnabled}
            onChange={(e) => onFollowChange(e.target.checked)}
          />
          跟手：人 m 次 / 教师 n 步
        </label>
      </div>
      {followEnabled ? (
        <div className="mb-3 space-y-3">
          <Slider
            label="人左右次数 m"
            value={followMoves}
            min={FOLLOW_MOVES_MIN}
            max={FOLLOW_MOVES_MAX}
            step={1}
            format={(v) => `${v} 次`}
            onChange={onFollowMovesChange}
          />
          <Slider
            label="随后教师左右 n"
            value={followSteps}
            min={FOLLOW_STEPS_MIN}
            max={FOLLOW_STEPS_MAX}
            step={1}
            format={(v) => `${v} 步`}
            onChange={onFollowStepsChange}
          />
        </div>
      ) : null}
      <div className="rounded-xl border border-[var(--border)] bg-[#0f1526] px-3 py-2 text-sm">
        <div className="muted text-xs">策略</div>
        <div className="font-mono text-xs">{strategy}</div>
        <div className="muted mt-2 text-xs">最近动作</div>
        <div className="font-mono text-xs">{lastAction}</div>
        {latencyMs != null && <div className="muted mt-1 text-xs">规划 {latencyMs.toFixed(1)} ms</div>}
      </div>
    </Panel>
  )
}
