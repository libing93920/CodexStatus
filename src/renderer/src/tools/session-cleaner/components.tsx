import { createElement } from 'react'
import type { ReactNode } from 'react'
import { REFERENCE_ICONS } from './reference-icons'
import { HelpTip } from './HelpTip'
export { HelpTip } from './HelpTip'

export type IconName = keyof typeof REFERENCE_ICONS

export function Icon({ name, className = '' }: { name: IconName; className?: string }): ReactNode {
  return (
    <svg className={`icon ${className}`} aria-hidden="true" viewBox="0 0 24 24">
      {REFERENCE_ICONS[name].map((shape, index) =>
        createElement(shape.tag, { ...shape.attributes, key: index })
      )}
    </svg>
  )
}

export function PageHeading({
  id,
  title,
  description,
  actions
}: {
  id: string
  title: string
  description: string
  actions?: ReactNode
}): ReactNode {
  return (
    <header className="page-heading">
      <div className="title-with-help">
        <h1 id={id} tabIndex={-1}>
          {title}
        </h1>
        {description ? <HelpTip text={description} /> : null}
      </div>
      {actions ? <div className="heading-actions">{actions}</div> : null}
    </header>
  )
}

export function StatusBadge({ label, tone }: { label: string; tone: string }): ReactNode {
  const color =
    tone === 'candidate'
      ? 'green'
      : tone === 'warning'
        ? 'amber'
        : tone === 'danger'
          ? 'danger'
          : 'neutral'
  return <span className={`status-pill ${color}`}>{label}</span>
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string
  description: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="review-empty">
      <Icon name="info" />
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="empty-actions">{action}</div> : null}
    </div>
  )
}
