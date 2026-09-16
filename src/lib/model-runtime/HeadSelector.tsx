import { useState } from 'react'
import type { ModelHeadOption } from './modelServiceApi'
import { REVE_TASKS, reveTaskOption } from './reveTasks'

function headTime(head: ModelHeadOption): string {
  const value = head.trainedAt || head.updatedAt
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未知'
  return `${head.trainedAt ? '训练' : '修改'} ${new Date(value).toLocaleString('zh-CN', { hour12: false })}`
}

function visibleHeads(heads: ModelHeadOption[], filter: string, task: string): ModelHeadOption[] {
  return heads.filter(h => filter === 'all' || (filter === 'current' ? h.task === task : (h.task || 'unknown') === filter))
    .sort((a, b) => (Date.parse(b.trainedAt || b.updatedAt || '') || 0) - (Date.parse(a.trainedAt || a.updatedAt || '') || 0) || a.name.localeCompare(b.name))
}

export function HeadSelector({ heads, task, value, onChange, disabled, label = '线性头', defaultLabel = '默认配置' }: {
  heads: ModelHeadOption[]; task: string; value: string; onChange: (value: string) => void
  disabled?: boolean; label?: string; defaultLabel?: string
}) {
  const [filter, setFilter] = useState('current')
  const options = visibleHeads(heads, filter, task)
  const selected = heads.find(h => h.id === value)
  return <div className="grid min-w-0 max-w-full gap-2">
    <label className="grid gap-1 text-sm">任务类型筛选
      <select aria-label={`${label}任务类型筛选`} className="input w-full" disabled={disabled} value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="current">当前任务 · {reveTaskOption(task)?.label || task}</option>
        <option value="all">全部任务</option>
        {REVE_TASKS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        <option value="unknown">未知任务</option>
      </select>
    </label>
    <label className="grid min-w-0 gap-1 text-sm">{label}
      <select aria-label={label} className="input w-full min-w-0 max-w-full" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        <option value="">{defaultLabel}</option>
        {value && !options.some(h => h.id === value) && <option value={value} disabled>当前选择（{selected ? '筛选外' : '文件不存在'}）：{selected ? `${headTime(selected)} · ${selected.name}` : value}</option>}
        {options.map(h => <option key={h.id} value={h.id} disabled={!h.available || h.task !== task}>
          {headTime(h)} · {h.gazeReport ? `${h.gazeReport.subjectId} · ${h.gazeReport.activeClasses.join('/')} · ` : ''}{reveTaskOption(h.task)?.short || h.task || '未知任务'} · {h.name}{!h.available ? ` · 不可用：${h.reason}` : h.task !== task ? ' · 与当前任务不匹配' : ''}
        </option>)}
      </select>
    </label>
    <p className="muted m-0 text-xs">最新时间优先；老文件没有训练时间时显示文件修改时间。{!options.length ? '当前筛选无结果。' : ''}</p>
  </div>
}
