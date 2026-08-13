import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgeAnnouncement,
  createAnnouncementState,
  formatAnnouncementTime,
  markAnnouncementRead,
  parseAnnouncementText,
  resolveAnnouncementRelativeDay,
  resolveCapsuleAlert
} from '../src/shared/announcement.ts'

const BASE_MESSAGE = {
  type: 'message',
  id: 'announcement',
  senderPeerId: 'peer',
  senderNickname: 'peer',
  sentAt: 1,
  text: '公告正文'
}

test('仅解析严格位于开头的 #gg 标识并清理正文空白', () => {
  assert.equal(parseAnnouncementText('#gg 公告正文'), '公告正文')
  assert.equal(parseAnnouncementText('#gg   多行公告 \n'), '多行公告')
  assert.equal(parseAnnouncementText('#gg '), undefined)
  assert.equal(parseAnnouncementText('#gg    '), undefined)
  assert.equal(parseAnnouncementText('普通消息 #gg 公告正文'), undefined)
  assert.equal(parseAnnouncementText(' #gg 公告正文'), undefined)
  assert.equal(parseAnnouncementText('#GG 公告正文'), undefined)
  assert.equal(parseAnnouncementText('#gg公告正文'), undefined)
})

test('新公告状态覆盖旧公告', () => {
  let state = createAnnouncementState({ ...BASE_MESSAGE, id: 'old' }, 'self')
  state = createAnnouncementState({ ...BASE_MESSAGE, id: 'new' }, 'self')

  assert.equal(state.message.id, 'new')
})

test('自己发布默认已读，他人发布先保持未读', () => {
  assert.equal(
    createAnnouncementState({ ...BASE_MESSAGE, senderPeerId: 'self' }, 'self').unread,
    false
  )
  assert.equal(createAnnouncementState(BASE_MESSAGE, 'self').unread, true)
})

test('已读操作仅作用于匹配 id，旧操作不能清新公告', () => {
  const state = createAnnouncementState({ ...BASE_MESSAGE, id: 'new' }, 'self')

  assert.equal(markAnnouncementRead(state, 'old'), state)
  assert.deepEqual(markAnnouncementRead(state, 'new'), { ...state, unread: false })
})

test('已知操作仅移除匹配 id，旧操作不能清新公告', () => {
  const state = createAnnouncementState({ ...BASE_MESSAGE, id: 'new' }, 'self')

  assert.equal(acknowledgeAnnouncement(state, 'old'), state)
  assert.equal(acknowledgeAnnouncement(state, 'new'), null)
})

test('胶囊提醒颜色和点击目标共用红蓝黄消息优先级', () => {
  assert.equal(resolveCapsuleAlert(true, true, true, true), 'red')
  assert.equal(resolveCapsuleAlert(false, true, true, true), 'blue')
  assert.equal(resolveCapsuleAlert(false, false, true, true), 'yellow')
  assert.equal(resolveCapsuleAlert(false, false, false, true), 'message')
  assert.equal(resolveCapsuleAlert(false, false, false, false), 'default')
})

test('公告时间只在跨日时显示昨天或前天，超过两天回退日期', () => {
  const now = new Date(2026, 7, 13, 16, 0).getTime()
  const today = new Date(2026, 7, 13, 8, 5).getTime()
  const yesterday = new Date(2026, 7, 12, 8, 5).getTime()
  const dayBeforeYesterday = new Date(2026, 7, 11, 8, 5).getTime()
  const earlier = new Date(2026, 7, 10, 8, 5).getTime()

  assert.equal(resolveAnnouncementRelativeDay(today, now), 'today')
  assert.equal(resolveAnnouncementRelativeDay(yesterday, now), 'yesterday')
  assert.equal(resolveAnnouncementRelativeDay(dayBeforeYesterday, now), 'day-before-yesterday')
  assert.equal(resolveAnnouncementRelativeDay(earlier, now), 'date')
  assert.match(formatAnnouncementTime(yesterday, now, 'zh-CN'), /^昨天 /)
  assert.match(formatAnnouncementTime(dayBeforeYesterday, now, 'zh-CN'), /^前天 /)
})
