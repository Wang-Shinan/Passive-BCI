import { Icon, type IconName } from './Icon'
import type { ReactNode } from 'react'

export function Panel({
  title,
  icon,
  children,
  className = '',
  actions,
}: {
  title?: string
  icon?: IconName
  children: ReactNode
  className?: string
  actions?: ReactNode
}) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="m-0 flex items-center gap-2 text-base font-semibold tracking-wide">{icon && <Icon name={icon} size={17} />}{title}</h2> : <span />}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}
