import { type ImpedanceRowState } from './analysis/impedance'

export type ImpedanceHardware = 'omni' | 'bcigo' | 'none'
export type { ImpedanceRowState }

export function ImpedanceTable({
  channelNames,
  rows,
  measuring,
  onToggle,
}: {
  channelNames: string[]
  rows: ImpedanceRowState[]
  measuring: boolean
  onToggle: (index: number, selected: boolean) => void
}) {
  return (
    <table className="acq-z-table">
      <thead>
        <tr>
          <th>通道</th>
          <th>阻抗</th>
          <th>接触质量</th>
        </tr>
      </thead>
      <tbody>
        {channelNames.map((name, i) => {
          const row = rows[i]
          const enabled = row?.enabled !== false
          return (
            <tr key={`${name}-${i}`}>
              <td>
                <label className="acq-z-ch">
                  <input
                    type="checkbox"
                    checked={Boolean(row?.selected)}
                    disabled={!enabled || measuring}
                    onChange={(e) => onToggle(i, e.target.checked)}
                  />
                  {name}
                </label>
              </td>
              <td className="acq-z-val">{row?.text ?? '等待检测'}</td>
              <td className="acq-z-q" style={{ color: row?.color || undefined, fontWeight: 700 }}>
                {row?.quality === 'good'
                  ? '良好'
                  : row?.quality === 'ok'
                    ? '可用'
                    : row?.quality === 'poor'
                      ? '接触不良'
                      : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function ImpedancePanel({
  hardware,
  channelNames,
  rows,
  measuring,
  seriesKohm,
  onSeriesKohm,
  detail,
  note,
  onStart,
  onStop,
  onToggle,
  dialog,
  onClose,
}: {
  hardware: ImpedanceHardware
  channelNames: string[]
  rows: ImpedanceRowState[]
  measuring: boolean
  seriesKohm: number
  onSeriesKohm: (v: number) => void
  detail?: string
  note?: string
  onStart: () => void
  onStop: () => void
  onToggle: (index: number, selected: boolean) => void
  dialog?: boolean
  onClose?: () => void
}) {
  const omniNote =
    note ??
    (hardware === 'omni'
      ? 'ADS1299 交流导联脱落检测：6 nA @ 31.25 Hz。SRB2 时激励 INxN，SRB1 时激励 INxP；检测期间不写入 EEG BIN。'
      : hardware === 'bcigo'
        ? '强脑 Lead-Off：6 nA @ 31.25 Hz（SDK）。有硬件读数时直接显示；否则用同一正弦拟合估计。检测期间不写入 EEG BIN。'
        : '当前设备没有 ADS1299 A9 交流导联脱落。无法测量电极阻抗。')

  const body = (
    <>
      <p className="acq-z-note">{omniNote}</p>
      {hardware === 'omni' ? (
        <label className="acq-field acq-z-series">
          板载输入串联电阻补偿
          <input
            className="input"
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={seriesKohm}
            disabled={measuring}
            onChange={(e) => onSeriesKohm(Number(e.target.value) || 0)}
          />
          <span className="muted">kΩ</span>
        </label>
      ) : null}
      <ImpedanceTable
        channelNames={channelNames}
        rows={rows}
        measuring={measuring}
        onToggle={onToggle}
      />
      <p className="acq-hint">判定：良好 &lt; 10 kΩ；可用 10–50 kΩ；接触不良 &gt; 50 kΩ</p>
      {detail ? <p className="acq-z-detail">{detail}</p> : null}
      <div className="acq-modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={hardware === 'none' || measuring}
          onClick={onStart}
        >
          开始检测
        </button>
        <button type="button" className="btn" disabled={!measuring} onClick={onStop}>
          停止并关闭激励
        </button>
        <span style={{ flex: 1 }} />
        {dialog && onClose ? (
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        ) : null}
      </div>
    </>
  )

  if (!dialog) return <div className="acq-z-panel">{body}</div>

  return (
    <div className="acq-modal-backdrop" onClick={onClose}>
      <div
        className="acq-modal acq-z-modal"
        role="dialog"
        aria-labelledby="acq-z-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="acq-z-title" className="acq-modal-title">
          电极阻抗检测
        </h3>
        {body}
      </div>
    </div>
  )
}
