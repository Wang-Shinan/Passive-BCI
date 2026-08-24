import { useEffect, useRef, useState } from 'react'
import { Slider } from '../ui/Slider'
import {
  DEFAULT_TEMPORAL_FILTER,
  TemporalEvidenceFilter,
  loadTemporalFilterConfig,
  saveTemporalFilterConfig,
  type TemporalFilterConfig,
  type TemporalFilterMode,
  horizonWindows,
} from './temporalEvidence'

export function useTemporalFilter(stepSec = DEFAULT_TEMPORAL_FILTER.stepSec) {
  const [config, setConfig] = useState<TemporalFilterConfig>(() => ({
    ...loadTemporalFilterConfig(),
    stepSec,
  }))
  const filterRef = useRef(new TemporalEvidenceFilter({ ...loadTemporalFilterConfig(), stepSec }))

  useEffect(() => {
    const next = { ...config, stepSec }
    filterRef.current.setConfig(next)
    saveTemporalFilterConfig(next)
  }, [config, stepSec])

  return { config, setConfig, filterRef }
}

const MODES: { id: TemporalFilterMode; label: string }[] = [
  { id: 'raw', label: '原始 argmax' },
  { id: 'ema', label: 'EMA logits' },
  { id: 'window', label: '滑窗均值' },
  { id: 'hmm', label: 'HMM 粘滞' },
]

export function TemporalFilterControls({
  config,
  onChange,
  compact = false,
}: {
  config: TemporalFilterConfig
  onChange: (next: TemporalFilterConfig) => void
  compact?: boolean
}) {
  const n = horizonWindows(config)
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <label className="block space-y-1">
        <span className="muted text-sm">时间滤波</span>
        <select
          className="select"
          value={config.mode}
          onChange={(event) =>
            onChange({ ...config, mode: event.target.value as TemporalFilterMode })
          }
        >
          {MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      {config.mode === 'ema' ? (
        <Slider
          label="EMA α"
          value={config.alpha}
          min={0.05}
          max={0.8}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(alpha) => onChange({ ...config, alpha })}
        />
      ) : null}
      {config.mode === 'hmm' ? (
        <Slider
          label="粘滞 P(stay)"
          value={config.stayProb}
          min={0.7}
          max={0.99}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(stayProb) => onChange({ ...config, stayProb })}
        />
      ) : null}
      {config.mode === 'window' ? (
        <Slider
          label="累积窗"
          value={config.horizonSec}
          min={0.3}
          max={2}
          step={0.1}
          format={(v) => `${v.toFixed(1)} s · ${horizonWindows({ ...config, horizonSec: v })} 窗`}
          onChange={(horizonSec) => onChange({ ...config, horizonSec })}
        />
      ) : null}
      {config.mode !== 'raw' ? (
        <Slider
          label="温度 T"
          value={config.temperature}
          min={0.7}
          max={3}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(temperature) => onChange({ ...config, temperature })}
        />
      ) : null}
      <p className="muted m-0 text-xs">
        {config.mode === 'raw'
          ? '每个 0.1s 窗独立 argmax。重叠窗会被当成新样本，容易闪动。'
          : config.mode === 'ema'
            ? `当前窗只占 ${(config.alpha * 100).toFixed(0)}% logits，其余来自历史。不平均 softmax。`
            : config.mode === 'window'
              ? `最近 ${n} 个重叠窗的 logits 取平均再 softmax。窗越多越稳，延迟越大。`
              : `P(y_t=y_{t-1})=${config.stayProb.toFixed(2)}。单次反手不会立刻切类，适合游戏控制。`}
      </p>
    </div>
  )
}
