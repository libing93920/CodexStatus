import type { CSSProperties, ReactNode } from 'react'
import type { CleanerSourceKind } from '../../../../shared/session-cleaner'
import { AgentIcon } from './AgentIcon'
import { AGENT_BRAND_COLORS } from './agent-brand'

export function AgentBadge({ kind }: { kind: CleanerSourceKind }): ReactNode {
  return (
    <span
      className="calm-agent-badge"
      data-agent-kind={kind}
      style={{ '--agent-color': AGENT_BRAND_COLORS[kind] } as CSSProperties}
      aria-hidden="true"
    >
      <AgentIcon kind={kind} />
    </span>
  )
}
