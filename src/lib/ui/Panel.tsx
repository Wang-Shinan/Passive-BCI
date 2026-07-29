import type { ReactNode } from 'react'

export function Panel({
  title,
  children,
  className = '',
  actions,
}: {
  title?: string
  children: ReactNode
  className?: string
  actions?: ReactNode
}) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="m-0 text-base font-semibold tracking-wide">{title}</h2> : <span />}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}
