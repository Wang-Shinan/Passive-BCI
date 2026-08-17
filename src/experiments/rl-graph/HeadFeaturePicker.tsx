import { useMemo, useState } from 'react'
import {
  FEATURE_CATALOG,
  FEATURE_GROUPS,
  labelForDisplayKey,
} from '../../lib/features/featureCatalog'
import {
  DEFAULT_LINEAR_HEAD_FEATURES,
  allHeadDisplayKeys,
  sanitizeHeadFeatures,
} from './linearHead'

export function HeadFeaturePicker({
  keys,
  onChange,
  disabled = false,
}: {
  keys: string[]
  onChange: (keys: string[]) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = useMemo(() => new Set(keys), [keys])
  const allKeys = useMemo(() => allHeadDisplayKeys(), [])
  const lightKeys = useMemo(
    () =>
      FEATURE_CATALOG.filter((f) => !f.heavy).flatMap((f) =>
        f.expandsTo?.length ? f.expandsTo : [f.id],
      ),
    [],
  )

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) {
      if (next.size <= 1) return
      next.delete(id)
    } else next.add(id)
    onChange(sanitizeHeadFeatures([...next]))
  }

  const setGroup = (groupId: string, on: boolean) => {
    const groupKeys = FEATURE_CATALOG.filter((f) => f.group === groupId).flatMap((f) =>
      f.expandsTo?.length ? f.expandsTo : [f.id],
    )
    const next = new Set(selected)
    for (const id of groupKeys) {
      if (on) next.add(id)
      else next.delete(id)
    }
    onChange(sanitizeHeadFeatures([...next]))
  }

  return (
    <div className={disabled ? 'pointer-events-none opacity-50' : ''}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn text-xs" onClick={() => setOpen((o) => !o)}>
          {open ? '收起特征' : `勾选特征（${keys.length}）`}
        </button>
        <button
          type="button"
          className="btn text-xs"
          onClick={() => onChange([...DEFAULT_LINEAR_HEAD_FEATURES])}
        >
          默认 8 项
        </button>
        <button type="button" className="btn text-xs" onClick={() => onChange(lightKeys)}>
          轻量全选
        </button>
        <button type="button" className="btn text-xs" onClick={() => onChange(allKeys)}>
          全部
        </button>
      </div>
      {open ? (
        <div className="mb-2 max-h-64 space-y-2 overflow-y-auto pr-1">
          {FEATURE_GROUPS.map((g) => {
            const items = FEATURE_CATALOG.filter((f) => f.group === g.id)
            const groupKeys = items.flatMap((f) => (f.expandsTo?.length ? f.expandsTo : [f.id]))
            const onCount = groupKeys.filter((id) => selected.has(id)).length
            return (
              <div key={g.id} className="rounded-md border border-[var(--border)] bg-[#0c1220] p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {g.label}{' '}
                    <span className="muted font-normal">
                      {onCount}/{groupKeys.length}
                    </span>
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn px-1.5 py-0.5 text-[10px]"
                      onClick={() => setGroup(g.id, true)}
                    >
                      全开
                    </button>
                    <button
                      type="button"
                      className="btn px-1.5 py-0.5 text-[10px]"
                      onClick={() => setGroup(g.id, false)}
                    >
                      全关
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-0.5">
                  {items.flatMap((f) =>
                    (f.expandsTo?.length ? f.expandsTo : [f.id]).map((id) => (
                      <label
                        key={id}
                        className="flex cursor-pointer items-center gap-1.5 text-[11px] leading-tight"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(id)}
                          onChange={() => toggle(id)}
                        />
                        <span className="font-mono">{labelForDisplayKey(id)}</span>
                        {f.heavy ? <span className="muted">重</span> : null}
                      </label>
                    )),
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
