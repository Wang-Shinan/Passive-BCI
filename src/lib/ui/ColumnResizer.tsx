import { useCallback, useRef, useState } from 'react'

/**
 * Vertical splitter between two layout columns.
 *
 * `onDragStart` lets the parent snapshot its current widths; every `onDrag`
 * then reports the total pointer offset from that snapshot.
 */
export function ColumnResizer({
  label,
  onDragStart,
  onDrag,
  onReset,
  className = '',
}: {
  label: string
  onDragStart: () => void
  onDrag: (deltaX: number) => void
  onReset?: () => void
  className?: string
}) {
  const originX = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      originX.current = event.clientX
      onDragStart()
      setDragging(true)
    },
    [onDragStart],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (originX.current == null) return
      onDrag(event.clientX - originX.current)
    },
    [onDrag],
  )

  const endDrag = useCallback(() => {
    if (originX.current == null) return
    originX.current = null
    setDragging(false)
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const step = (event.shiftKey ? 40 : 10) * (event.key === 'ArrowRight' ? 1 : -1)
      onDragStart()
      onDrag(step)
    },
    [onDrag, onDragStart],
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title={onReset ? `拖动调整${label} · 双击还原` : `拖动调整${label}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className={`group relative flex w-4 shrink-0 cursor-col-resize touch-none select-none justify-center self-stretch focus:outline-none ${className}`}
    >
      <span
        className={`h-full w-[3px] rounded-full transition-colors ${
          dragging
            ? 'bg-[var(--accent)]'
            : 'bg-[var(--border)] group-hover:bg-[color-mix(in_srgb,var(--accent)_60%,var(--border))] group-focus-visible:bg-[var(--accent)]'
        }`}
      />
      <span
        className={`pointer-events-none absolute top-1/2 h-9 w-[7px] -translate-y-1/2 rounded-full border border-[var(--border)] transition-opacity ${
          dragging
            ? 'bg-[var(--accent)] opacity-100'
            : 'bg-[var(--panel-2)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
        }`}
      />
    </div>
  )
}
