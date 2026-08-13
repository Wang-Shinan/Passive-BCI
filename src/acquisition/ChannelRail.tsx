/** OmniBCI-style left channel rail + per-channel settings dialog. */

import { CHANNEL_COLORS } from './WaveformCanvas'
import {
  VALID_GAINS,
  type ChannelConfig,
  type ReferenceMode,
  REFERENCE_SRB2,
} from './protocol/constants'

export const OMNI_CHANNEL_COLORS = [
  '#7B61FF',
  '#2478FF',
  '#00A6D6',
  '#00A878',
  '#8EBB2A',
  '#E0A800',
  '#F47A22',
  '#E84545',
]

export function channelColor(i: number, omni = true): string {
  const pal = omni ? OMNI_CHANNEL_COLORS : CHANNEL_COLORS
  return pal[i % pal.length]!
}

export function ChannelRail({
  names,
  visible,
  yScaleUv,
  omniCfg,
  onToggle,
  onOpen,
}: {
  names: string[]
  visible: boolean[]
  yScaleUv: number
  omniCfg?: ChannelConfig
  onToggle: (index: number) => void
  onOpen: (index: number) => void
}) {
  return (
    <aside className="acq-rail">
      <div className="acq-rail-head">通道参数（点击修改） / 幅值</div>
      <div className="acq-rail-list">
        {names.map((name, i) => {
          const on = visible[i] !== false
          const enabled = omniCfg ? omniCfg.enabled[i] !== false : on
          const color = channelColor(i)
          return (
            <button
              key={`${name}-${i}`}
              type="button"
              className={`acq-rail-row${on ? '' : ' is-off'}`}
              onClick={() => onOpen(i)}
              onDoubleClick={(e) => {
                e.preventDefault()
                onToggle(i)
              }}
              title="单击设置；双击开关显示"
            >
              <span
                className="acq-rail-dot"
                style={{ background: enabled && on ? '#56bd31' : '#c5c9ce' }}
              />
              <span className="acq-rail-name" style={{ color }}>
                {name}
                {omniCfg ? (
                  <span className="acq-rail-meta">
                    {omniCfg.enabled[i] ? 'ON' : 'OFF'} · ×{omniCfg.gains[i]}
                    {omniCfg.bias[i] ? ' · BIAS' : ''}
                  </span>
                ) : null}
              </span>
              <span className="acq-rail-scale">{yScaleUv} µV</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

export function ChannelSettingsDialog({
  index,
  name,
  cfg,
  reference,
  streaming,
  onClose,
  onChange,
  onApply,
}: {
  index: number
  name: string
  cfg: ChannelConfig
  reference: ReferenceMode
  streaming: boolean
  onClose: () => void
  onChange: (next: ChannelConfig) => void
  onApply: (cfg: ChannelConfig) => void
}) {
  const srb2Mode = reference === REFERENCE_SRB2
  const patch = (fn: (c: ChannelConfig) => ChannelConfig) => onChange(fn(cfg))
  return (
    <div className="acq-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="acq-modal"
        role="dialog"
        aria-labelledby="acq-ch-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="acq-ch-title" className="acq-modal-title">
          {name} 通道设置
        </h3>
        <div className="acq-modal-summary">
          CH{index + 1} | {cfg.enabled[index] ? 'ON' : 'OFF'} | PGA ×{cfg.gains[index]} | BIAS{' '}
          {cfg.bias[index] ? 'YES' : 'NO'} | {srb2Mode ? `SRB2 ${cfg.srb2[index] ? 'ON' : 'OFF'}` : 'SRB1 GLOBAL'}
        </div>
        <label className="acq-check">
          <input
            type="checkbox"
            checked={cfg.enabled[index]}
            disabled={streaming}
            onChange={(e) =>
              patch((c) => {
                const enabled = [...c.enabled]
                enabled[index] = e.target.checked
                return { ...c, enabled }
              })
            }
          />
          启用该通道
        </label>
        <label className="acq-field acq-field-block">
          <span>PGA 增益</span>
          <select
            className="select"
            value={cfg.gains[index]}
            disabled={streaming}
            onChange={(e) =>
              patch((c) => {
                const gains = [...c.gains]
                gains[index] = Number(e.target.value)
                return { ...c, gains }
              })
            }
          >
            {VALID_GAINS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="acq-check">
          <input
            type="checkbox"
            checked={cfg.bias[index]}
            disabled={streaming}
            onChange={(e) =>
              patch((c) => {
                const bias = [...c.bias]
                bias[index] = e.target.checked
                return { ...c, bias }
              })
            }
          />
          加入 BIAS 共模反馈
        </label>
        <label className="acq-check">
          <input
            type="checkbox"
            checked={cfg.srb2[index]}
            disabled={streaming || !srb2Mode}
            onChange={(e) =>
              patch((c) => {
                const srb2 = [...c.srb2]
                srb2[index] = e.target.checked
                return { ...c, srb2 }
              })
            }
          />
          该通道接入 SRB2 公共参考
        </label>
        <p className="acq-hint">
          {srb2Mode
            ? 'SRB2 模式：测量电极接 INxN，公共参考接 SRB2。'
            : 'SRB1 模式：测量电极接 INxP，公共参考接 SRB1；逐通道 SRB2 不生效。'}
        </p>
        <div className="acq-modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={streaming}
            onClick={() => {
              onApply(cfg)
              onClose()
            }}
          >
            应用到设备
          </button>
        </div>
      </div>
    </div>
  )
}
