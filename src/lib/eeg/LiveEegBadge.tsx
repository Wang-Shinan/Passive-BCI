import { Link } from 'react-router-dom'
import { useLiveEeg } from './useLiveEeg'

const DEVICE_LABEL: Record<string, string> = {
  omni: 'OmniBCI',
  neuracle: '博睿康',
  bcigo: '强脑',
  demo: '采集演示',
}

export function LiveEegBadge({ className }: { className?: string }) {
  const { live, stale, meta } = useLiveEeg()
  let label = '未连接'
  let color = 'var(--muted)'
  let hint = '先在采集页连接设备并点「开始采集」。'

  if (meta.link === 'connecting') {
    label = '连接中'
    hint = meta.detail || '正在连接设备…'
  } else if (meta.link === 'open') {
    label = '已连接 · 待采集'
    color = 'var(--accent)'
    hint = '设备已连上，请到采集页点「开始采集」。'
  } else if (live) {
    const dev = meta.device ? DEVICE_LABEL[meta.device] ?? meta.device : ''
    label = dev ? `实时流中 · ${dev}` : '实时流中'
    color = 'var(--accent-2)'
    hint = `${meta.channelNames.length || '—'} 通道 @ ${meta.sampleRate} Hz`
  } else if (stale) {
    label = '已过期'
    color = 'var(--danger)'
    hint = '流暂时卡住了，会再等十几秒。真正断流才回采集页。'
  } else if (meta.link === 'error') {
    label = '连接错误'
    color = 'var(--danger)'
    hint = meta.detail || '采集连接出错。'
  }

  return (
    <div className={className}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="chip" style={{ color, borderColor: `${color}66` }}>
          EEG {label}
        </span>
        <Link to="/acquisition" className="text-xs" style={{ color: 'var(--accent)' }}>
          采集页 →
        </Link>
      </div>
      <p className="muted mb-0 text-xs leading-relaxed">{hint}</p>
    </div>
  )
}
