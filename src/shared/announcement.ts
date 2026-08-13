import type { AnnouncementState, BroadcastMessage, LocaleCode } from './capsule'

export const ANNOUNCEMENT_PREFIX = '#gg '
export type CapsuleAlert = 'red' | 'blue' | 'yellow' | 'message' | 'default'

/** 仅把严格位于开头的 #gg 消息解析为公告正文。 */
export function parseAnnouncementText(text: string): string | undefined {
  if (!text.startsWith(ANNOUNCEMENT_PREFIX)) {
    return undefined
  }

  return text.slice(ANNOUNCEMENT_PREFIX.length).trim() || undefined
}

export function createAnnouncementState(
  message: BroadcastMessage,
  selfPeerId: string
): AnnouncementState {
  return {
    message,
    unread: message.senderPeerId !== selfPeerId
  }
}

export function resolveCapsuleAlert(
  hasUpdate: boolean,
  hasUnreadAnnouncement: boolean,
  isOutdated: boolean,
  hasMessage: boolean
): CapsuleAlert {
  if (hasUpdate) return 'red'
  if (hasUnreadAnnouncement) return 'blue'
  if (isOutdated) return 'yellow'
  return hasMessage ? 'message' : 'default'
}

export type AnnouncementRelativeDay = 'today' | 'yesterday' | 'day-before-yesterday' | 'date'

export function resolveAnnouncementRelativeDay(
  sentAt: number,
  now: number
): AnnouncementRelativeDay {
  const sentDate = new Date(sentAt)
  const nowDate = new Date(now)
  const sentMidnight = new Date(
    sentDate.getFullYear(),
    sentDate.getMonth(),
    sentDate.getDate()
  ).getTime()
  const nowMidnight = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate()
  ).getTime()
  const daysAgo = Math.round((nowMidnight - sentMidnight) / 86_400_000)

  if (daysAgo === 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  if (daysAgo === 2) return 'day-before-yesterday'
  return 'date'
}

export function formatAnnouncementTime(sentAt: number, now: number, locale: LocaleCode): string {
  const sentDate = new Date(sentAt)
  const time = sentDate.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  const relativeDay = resolveAnnouncementRelativeDay(sentAt, now)

  if (relativeDay === 'today') return time
  if (relativeDay === 'yesterday') return locale === 'zh-CN' ? `昨天 ${time}` : `Yesterday ${time}`
  if (relativeDay === 'day-before-yesterday') {
    return locale === 'zh-CN' ? `前天 ${time}` : `2 days ago ${time}`
  }
  return `${sentDate.getMonth() + 1}/${sentDate.getDate()} ${time}`
}

export function markAnnouncementRead(state: AnnouncementState, id: string): AnnouncementState {
  if (state.message.id !== id || !state.unread) {
    return state
  }

  return { ...state, unread: false }
}

export function acknowledgeAnnouncement(
  state: AnnouncementState,
  id: string
): AnnouncementState | null {
  return state.message.id === id ? null : state
}
