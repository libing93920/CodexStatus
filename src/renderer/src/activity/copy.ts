import type { LocaleCode } from '../../../shared/capsule'

const zh = {
  ranking: '排行榜',
  management: '管理',
  title: '团队活动观察',
  date: '观察日',
  weekdays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  restday: '非工作日',
  noCalendar: '工作日数据暂不可用，无法展示活动。',
  loading: '正在读取活动观察…',
  loadFailed: '读取失败',
  retry: '重试',
  empty: '暂无成员',
  members: '成员',
  anonymous: '未命名成员',
  active: '活动',
  inactive: '未活动',
  mismatch: '活动时段口径不一致。',
  incomplete: '记录不完整。',
  noDay: '暂无记录',
  timeline: '当天工作时段活动',
  morning: '上午',
  afternoon: '下午',
  minutes: '分',
  seconds: '秒',
  staleData: '以下为上次成功读取的记录。'
}

const en: typeof zh = {
  ranking: 'Rankings',
  management: 'Activity',
  title: 'Team activity observations',
  date: 'Observation day',
  weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  restday: 'Non-workday',
  noCalendar: 'Workday data unavailable. Activity cannot be displayed.',
  loading: 'Loading observations…',
  loadFailed: 'Could not load',
  retry: 'Retry',
  empty: 'No members yet',
  members: 'Members',
  anonymous: 'Unnamed member',
  active: 'Active',
  inactive: 'Inactive',
  mismatch: 'Activity windows differ.',
  incomplete: 'Incomplete record.',
  noDay: 'No records',
  timeline: 'Daily work-window activity',
  morning: 'AM',
  afternoon: 'PM',
  minutes: 'm',
  seconds: 's',
  staleData: 'Showing the last successfully loaded records.'
}

export function activityCopy(locale: LocaleCode): typeof zh {
  return locale === 'zh-CN' ? zh : en
}
export type ActivityCopy = typeof zh
