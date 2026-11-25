import { liveEegHub } from '../eeg/liveHub'
import { useLiveEeg } from '../eeg/useLiveEeg'
import { isNonScalpEegChannel, LIVE_FEATURE_CHANNEL_CAP } from './bandFeatures'

export function FeatureChannelPicker({
  channelNames,
  channelTypes,
  subset,
  onSubsetChange,
}: {
  channelNames?: string[]
  channelTypes?: string[]
  subset?: boolean[] | null
  onSubsetChange?: (mask: boolean[] | null) => void
}) {
  const { meta } = useLiveEeg()
  const names = channelNames ?? meta.channelNames
  const types = channelTypes ?? meta.channelTypes
  const selected = liveEegHub.selectedFeatureChannels(names, subset)
  const available = names.map((name, i) => !isNonScalpEegChannel(name, types[i]) && !liveEegHub.isBad(name))
  const count = selected.filter((on, i) => on && available[i]).length
  const automatic = !liveEegHub.hasFeatureChannelSelection && !subset

  function change(mask: boolean[] | null) {
    if (onSubsetChange) onSubsetChange(mask)
    else liveEegHub.setFeatureChannelSelection(names, mask)
  }

  const localMask = subset ?? names.map(() => true)
  const editable = onSubsetChange ? localMask : selected
  const allowedBySharedSelection = onSubsetChange
    ? liveEegHub.selectedFeatureChannels(names, names.map(() => true))
    : null

  return (
    <details className="mb-3 rounded border border-[var(--border)] p-2 text-xs">
      <summary className="cursor-pointer font-semibold">
        {onSubsetChange ? '反馈特征通道' : '特征通道'}
        {names.length ? ` · ${automatic ? `自动（最多 ${LIVE_FEATURE_CHANNEL_CAP} 路）` : `已选 ${count} 路`}` : ''}
      </summary>
      {names.length ? (
        <>
          <div className="my-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn secondary" onClick={() => change(names.map(() => true))}>全选 EEG</button>
            <button type="button" className="btn secondary" onClick={() => change(names.map(() => false))}>取消全选</button>
            <button type="button" className="btn secondary" onClick={() => change(null)}>
              {onSubsetChange ? '恢复默认' : '恢复自动'}
            </button>
          </div>
          <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-2 overflow-y-auto">
            {names.map((name, i) => {
              const blocked = allowedBySharedSelection?.[i] === false
              const bad = liveEegHub.isBad(name)
              const reason = bad ? '坏道' : !available[i] ? '非 EEG' : blocked ? '共享设置已排除' : ''
              return (
                <label key={`${name}-${i}`} className="flex items-center gap-1.5 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={available[i] === true && selected[i] === true}
                    disabled={!available[i] || blocked}
                    onChange={(event) => {
                      const next = [...editable]
                      next[i] = event.target.checked
                      change(next)
                    }}
                  />
                  {name}{reason ? `（${reason}）` : ''}
                </label>
              )
            })}
          </div>
          <p className="muted mb-0 mt-2" role="status">
            {count === 0
              ? '没有可用于计算的通道。'
              : onSubsetChange
                ? '此处的勾选用于本页反馈。'
                : `采集页与实验页共用。自动模式和高开销特征最多使用 ${LIVE_FEATURE_CHANNEL_CAP} 路。`}
          </p>
        </>
      ) : <p className="muted mb-0 mt-2">连接 EEG 后可勾选通道。</p>}
    </details>
  )
}
