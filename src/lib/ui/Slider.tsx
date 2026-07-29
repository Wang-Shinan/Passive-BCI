export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
}) {
  return (
    <label className="block space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="muted">{label}</span>
        <span className="font-mono text-[0.85rem]">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        className="w-full accent-[var(--accent)]"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}
