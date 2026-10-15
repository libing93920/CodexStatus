/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { build } from 'esbuild'

app.disableHardwareAcceleration()
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'activity-ui-'))
app.setPath('userData', directory)
const errors = []
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const HIDDEN_POLL_WAIT_MS = 30_100
const RESTORED_POLL_WAIT_MS = 10_300
let window
const watchdog = setTimeout(() => {
  console.error('Activity UI watchdog timeout')
  window?.destroy()
  app.exit(1)
}, 150_000)

async function cssTree(file, seen = new Set()) {
  if (seen.has(file)) return ''
  seen.add(file)
  const parts = (await readFile(file, 'utf8')).split(/(@import\s+['"][^'"]+['"]\s*;)/g)
  let result = ''
  for (const part of parts) {
    const match = part.match(/^@import\s+['"]([^'"]+)['"]\s*;$/)
    result += match ? await cssTree(resolve(dirname(file), match[1]), seen) : part
  }
  return result
}

const evaluate = (expression) => window.webContents.executeJavaScript(expression, true)

async function waitFor(expression, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await evaluate(expression)) return
    await delay(40)
  }
  throw new Error('UI timed out: ' + expression + '; console: ' + errors.join('; '))
}

async function clickText(text) {
  const clicked = await evaluate(
    "(() => { const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === " +
      JSON.stringify(text) +
      '); if (!button) return false; button.click(); return true })()'
  )
  assert.equal(clicked, true, 'button exists: ' + text)
  await delay(80)
}

async function clickSelector(selector) {
  const clicked = await evaluate(
    '(() => { const element = document.querySelector(' +
      JSON.stringify(selector) +
      '); if (!element) return false; element.click(); return true })()'
  )
  assert.equal(clicked, true, 'element exists: ' + selector)
  await delay(80)
}

async function mount(view) {
  await evaluate('activityFixture.mount(' + JSON.stringify(view) + ')')
  await delay(120)
}

async function verifyActivityWeek() {
  const week = await evaluate(`(() => {
    const days = Array.from(document.querySelectorAll('.activity-week__day'))
    return {
      labels: days.map(button => button.textContent.trim()),
      current: days.find(button => button.getAttribute('aria-current') === 'date')?.textContent.trim(),
      pressed: days.filter(button => button.getAttribute('aria-pressed') === 'true').length,
      currentPressed: days.find(button => button.getAttribute('aria-current') === 'date')?.getAttribute('aria-pressed'),
      disabled: days.map(button => button.disabled),
      hasSelect: !!document.querySelector('.activity select'),
      removedCards: ['.activity-calendar', '.activity-metrics', '.activity-stat', '.activity-diagnostics',
        '.activity-range', '.activity-help', '.activity-description'].some(selector => document.querySelector(selector))
    }
  })()`)
  assert.deepEqual(week.labels, WEEKDAYS)
  assert.equal(week.current, '周二')
  assert.equal(week.currentPressed, 'true')
  assert.equal(week.pressed, 1)
  assert.deepEqual(week.disabled, [false, false, true, true, true, true, true])
  assert.equal(week.hasSelect, false)
  assert.equal(week.removedCards, false)

  const before = await evaluate('activityFixture.boardCalls')
  await evaluate(
    "Array.from(document.querySelectorAll('.activity-week__day:disabled')).forEach(button => button.click())"
  )
  await delay(120)
  assert.equal(
    await evaluate('activityFixture.boardCalls'),
    before,
    'future weekdays make no requests'
  )
  console.log('PASS week selector: Monday to Sunday, current day selected, future days disabled')
}

async function verifyFixedThreshold() {
  assert.equal(
    await evaluate("document.querySelector('.activity-advanced, .activity-threshold') === null"),
    true
  )
  await evaluate('activityFixture.setSettings({ activityIdleThresholdMinutes: 17 })')
  assert.equal(await evaluate('activityFixture.settings().activityIdleThresholdMinutes'), 5)
  assert.equal(
    await evaluate("document.querySelector('.activity').textContent.includes('空闲阈值')"),
    false
  )
  console.log(
    'PASS fixed threshold: 5 minutes, previous custom values ignored, settings UI removed'
  )
}

async function verifyAppRoutesAndPolling() {
  await clickText('设置')
  await waitFor("!document.querySelector('.activity')")
  assert.equal(await evaluate("document.querySelector('.activity-capture') === null"), true)
  assert.equal(
    await evaluate("document.querySelector('.panel__content').textContent.includes('默认关闭')"),
    false
  )
  assert.equal(
    await evaluate(
      "document.querySelector('.panel__content').textContent.includes('工作时段活动分享')"
    ),
    false
  )
  await clickText('团队')
  await waitFor("document.querySelector('.activity-tabs')")
  await clickText('管理')
  await waitFor("document.querySelector('.activity-member__toggle')")

  await evaluate("activityFixture.setSettings({ teamGroup: '9527' })")
  await waitFor("document.querySelector('.activity') === null")
  assert.equal(await evaluate("document.querySelector('.activity-tabs') === null"), true)
  assert.equal(await evaluate('activityFixture.teamAdminAllowed'), true)
  const callsAfterRevocation = await evaluate('activityFixture.boardCalls')
  await delay(10_300)
  assert.equal(
    await evaluate('activityFixture.boardCalls'),
    callsAfterRevocation,
    'role removal stops polling'
  )

  await evaluate("activityFixture.setSettings({ teamGroup: '9527GM' })")
  await waitFor("document.querySelector('.activity-tabs')")
  await clickText('管理')
  await waitFor("document.querySelector('.activity-member__toggle')")
  console.log('PASS App routes: removed capture settings and revocation stops polling')
}

async function verifyTeamAdminAuthorization() {
  assert.equal(await evaluate("activityFixture.settings().teamGroup === '9527GM'"), true)

  await evaluate(
    'activityFixture.teamAdminAllowed = false; activityFixture.omitTeamAdminAllowedFromBootstrap = false'
  )
  let calls = await evaluate('activityFixture.boardCalls')
  await mount('app-remount')
  assert.equal(
    await evaluate("document.querySelector('.activity-tabs, .activity') === null"),
    true,
    'bootstrap false keeps the admin team group but hides management'
  )
  assert.equal(await evaluate('activityFixture.boardCalls'), calls)

  await evaluate(
    'activityFixture.teamAdminAllowed = true; activityFixture.omitTeamAdminAllowedFromBootstrap = true'
  )
  calls = await evaluate('activityFixture.boardCalls')
  await mount('app-remount')
  assert.equal(
    await evaluate("document.querySelector('.activity-tabs, .activity') === null"),
    true,
    'missing bootstrap authorization defaults to hidden'
  )
  assert.equal(await evaluate('activityFixture.boardCalls'), calls)

  await evaluate(
    'activityFixture.omitTeamAdminAllowedFromBootstrap = false; activityFixture.setTeamAdminAllowed(true)'
  )
  await waitFor("document.querySelector('.activity-tabs')")
  await clickText('管理')
  await waitFor("document.querySelector('.activity-member__toggle')")

  await evaluate('activityFixture.setTeamAdminAllowed(false)')
  await waitFor("document.querySelector('.activity-tabs, .activity') === null")
  await delay(120)
  calls = await evaluate('activityFixture.boardCalls')
  await delay(10_300)
  assert.equal(
    await evaluate('activityFixture.boardCalls'),
    calls,
    'preferences false hides management and stops activity polling'
  )

  await evaluate('activityFixture.setTeamAdminAllowed(true)')
  await waitFor("document.querySelector('.activity-tabs')")
  await clickText('管理')
  await waitFor("document.querySelector('.activity-member__toggle')")
  console.log(
    'PASS team admin authorization: bootstrap, missing field, preferences revoke and restore'
  )
}

async function setActivityCoverageCase(coverageCase) {
  await evaluate('activityFixture.coverageCase = ' + JSON.stringify(coverageCase))
}

async function verifyMemberSorting() {
  await evaluate(`(() => {
    activityFixture.beforeSortingBoard = window.codexStatus.getActivityBoard
    window.codexStatus.getActivityBoard = async date => {
      const board = await activityFixture.beforeSortingBoard(date)
      const member = board.members[0]
      board.members = [
        { ...member, id: 'unknown', nickname: '未知时间最多', summary: { ...member.summary, idleMs: 0, lockedMs: 0, suspendedMs: 0, unknownMs: 999999 } },
        { ...member, id: 'lower', nickname: '未活动较少', summary: { ...member.summary, idleMs: 100000, lockedMs: 0, suspendedMs: 0 } },
        { ...member, id: 'higher', nickname: '未活动最多', summary: { ...member.summary, idleMs: 50000, lockedMs: 100000, suspendedMs: 150000 } }
      ]
      return board
    }
  })()`)
  await mount('standalone-sorting')
  await waitFor(
    "document.querySelector('.activity-member__name')?.textContent.trim() === '未活动最多'"
  )
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.activity-member__name')).map(element => element.textContent.trim())"
    ),
    ['未活动最多', '未活动较少', '未知时间最多']
  )
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.activity-member__inactive')).map(element => element.textContent.trim())"
    ),
    ['0h:5m:0s', '0h:1m:40s', '0h:0m:0s']
  )
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('.activity-member__toggle')).every(button => button.getAttribute('aria-expanded') === 'false')"
    ),
    true
  )
  await evaluate('void (window.codexStatus.getActivityBoard = activityFixture.beforeSortingBoard)')
  console.log(
    'PASS member sorting: inactive duration descending, unknown excluded, collapsed by default'
  )
}

async function installMemberCountBoard(mode) {
  await evaluate(`(() => {
    activityFixture.memberCountOriginalFetch ??= window.codexStatus.getActivityBoard
    const scenario = ${JSON.stringify(mode)}
    window.codexStatus.getActivityBoard = async date => {
      const board = await activityFixture.memberCountOriginalFetch(date)
      const source = board.members[0]
      const self = { ...source, id: 'admin-self', nickname: '管理员自己', isSelf: true }
      if (scenario === 'self-only') {
        board.members = [self]
        return board
      }
      const visibleCount = date === '2026-10-12' ? 1 : 2
      board.members = [
        self,
        ...Array.from({ length: visibleCount }, (_, index) => ({
          ...source,
          id: 'visible-' + (index + 1),
          nickname: '可见成员 ' + (index + 1),
          isSelf: false
        }))
      ]
      return board
    }
  })()`)
}

async function verifyMemberCounts() {
  await evaluate("activityFixture.setSettings({ locale: 'zh-CN' })")
  await installMemberCountBoard('with-self')
  await mount('member-count-chinese')
  await waitFor("document.querySelector('.activity-members__heading .settings-section__title')")

  let view = await readMemberCountView()
  assert.equal(view.title, '成员（2）')
  assert.deepEqual(view.names.slice().sort(), ['可见成员 1', '可见成员 2'])
  assert.equal(view.names.length, 2)
  assert.equal(view.empty, '')
  await saveWarningScreenshot('activity-members-count.png')

  await selectAndWait('周一', '2026-10-12')
  await waitFor(
    "document.querySelector('.activity-members__heading .settings-section__title')?.textContent.trim() === '成员（1）'"
  )
  view = await readMemberCountView()
  assert.equal(view.title, '成员（1）')
  assert.deepEqual(view.names, ['可见成员 1'])
  assert.equal(view.names.length, 1)

  await evaluate("activityFixture.setSettings({ locale: 'en-US' })")
  await mount('member-count-english')
  await waitFor("document.querySelector('.activity-members__heading .settings-section__title')")
  view = await readMemberCountView()
  assert.equal(view.title, 'Members (2)')
  assert.equal(view.names.length, 2)
  assert.equal(view.names.includes('管理员自己'), false)

  await evaluate("activityFixture.setSettings({ locale: 'zh-CN' })")
  await installMemberCountBoard('self-only')
  await mount('member-count-self-only')
  await waitFor("document.querySelector('.activity-members__heading .settings-section__title')")
  view = await readMemberCountView()
  assert.equal(view.title, '成员（0）')
  assert.deepEqual(view.names, [])
  assert.equal(view.empty, '该观察日尚未收到活动记录')

  await evaluate(`(() => {
    window.codexStatus.getActivityBoard = activityFixture.memberCountOriginalFetch
    delete activityFixture.memberCountOriginalFetch
  })()`)
  console.log(
    'PASS member count: self excluded, date-specific count, zero-state, Chinese and English'
  )
}

async function readMemberCountView() {
  return evaluate(`(() => ({
    title: document.querySelector('.activity-members__heading .settings-section__title')?.textContent.trim(),
    names: Array.from(document.querySelectorAll('.activity-members .activity-member__name'))
      .map(element => element.textContent.trim()),
    empty: document.querySelector('.activity-members .activity-empty')?.textContent.trim() ?? ''
  }))()`)
}

async function verifyPanelDetailsAndTooltip() {
  await setActivityCoverageCase('detailed')
  await mount('standalone-initial')
  await waitFor("document.querySelector('.activity-member__toggle')")
  assert.equal(await evaluate("document.querySelector('.activity-timeline') === null"), true)
  const controls = await evaluate(
    "Array.from(document.querySelectorAll('.activity-member__toggle')).map(button => ({expanded:button.getAttribute('aria-expanded'),id:button.getAttribute('aria-controls')}))"
  )
  assert.ok(controls.every((control) => control.expanded === 'false'))
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.activity-member__inactive')).slice(1).map(element => element.textContent.trim())"
    ),
    ['--', '--']
  )
  assert.equal(new Set(controls.map((control) => control.id)).size, controls.length)
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.activity-legend span')).map(item => item.textContent.trim())"
    ),
    ['活动', '未活动']
  )
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-timeline')")
  await clickSelector('.activity-member__toggle')
  assert.equal(await evaluate("document.querySelector('.activity-timeline') === null"), true)
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-timeline')")
  const kinds = await evaluate(
    "Array.from(document.querySelectorAll('.activity-segment')).map(segment => segment.className)"
  )
  assert.ok(kinds.every((kind) => /activity-pattern--(active|inactive)$/.test(kind)))
  assert.equal(
    await evaluate("document.querySelector('.activity-timeline [role=tooltip]') === null"),
    true
  )
  const warning = await evaluate(`(() => {
    const item = document.querySelector('.activity-coverage-warning')
    return { text: item?.textContent.trim() ?? '', count: document.querySelectorAll('.activity-coverage-warning').length }
  })()`)
  assert.equal(warning.count, 1)
  assert.ok(warning.text.includes('无法确认'))
  assert.ok(warning.text.includes('未计入未活动'))
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-incomplete, .activity-calendar-comparison, .activity-unknown-range, .activity-diagnostic-point') === null"
    ),
    true
  )
  const detailText = await evaluate("document.querySelector('.activity-detail')?.textContent ?? ''")
  for (const oldDetail of [
    '记录不完整',
    '采样间隔过长',
    '系统输入状态不可用',
    '系统时间发生变化',
    '读取系统输入状态失败',
    '09:55:00',
    '10:45:00'
  ]) {
    assert.equal(
      detailText.includes(oldDetail),
      false,
      `Old diagnostic detail rendered: ${oldDetail}`
    )
  }
  assert.equal(
    await evaluate("document.querySelector('.activity-member__inactive')?.textContent.trim()"),
    '1h:19m:25s'
  )
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.activity-timeline__label')).map(label => label.textContent.trim())"
    ),
    ['上午', '下午']
  )

  await evaluate("document.querySelector('.activity-segment').focus()")
  assert.equal(await evaluate("document.activeElement.matches('.activity-segment')"), true)
  const details = await evaluate(
    "Array.from(document.querySelectorAll('.activity-segment')).map(segment => ({title:segment.title,label:segment.getAttribute('aria-label')}))"
  )
  assert.ok(details.every((detail) => detail.title && detail.title === detail.label))
  assert.deepEqual(
    details.slice(0, 2).map((detail) => detail.title),
    ['活动 · 08:30:00 - 09:00:00 · 30 分 0 秒', '未活动 · 09:00:00 - 09:30:00 · 30 分 0 秒']
  )
  await saveWarningScreenshot('activity-coverage-warning-detailed.png')
  console.log(
    'PASS members: collapsed by default, unique regions, two activity states, native tooltip text and keyboard labels'
  )
}

async function verifyActivityCoverageWarnings() {
  await evaluate("activityFixture.setNow('2026-10-13T14:30:00+08:00')")
  let syntheticGap
  let pointOnly
  let lunchGap
  for (const coverageCase of [
    'summary-gap',
    'complete-incomplete',
    'outside-window-unknown',
    'lunch-unknown',
    'future-unknown',
    'point-only-diagnostic'
  ]) {
    await setActivityCoverageCase(coverageCase)
    await mount('coverage-' + coverageCase)
    await waitFor("document.querySelector('.activity-member__toggle')")
    await clickSelector('.activity-member__toggle')
    await waitFor("document.querySelector('.activity-timeline')")
    assert.equal(
      await evaluate("document.querySelector('.activity-coverage-warning') === null"),
      true,
      coverageCase + ': no warning for out-of-scope or synthesized unknown time'
    )
    assert.equal(
      await evaluate("document.querySelector('.activity-incomplete') === null"),
      true,
      coverageCase + ': incomplete flag alone must not render a warning'
    )
    if (coverageCase === 'summary-gap') {
      syntheticGap = await evaluate(`(() => {
        const day = activityFixture.lastBoard?.members[0]?.day
        const summary = activityFixture.lastBoard?.members[0]?.summary
        return {
          incomplete: day?.incomplete,
          rawUnknown: day?.intervals.some(interval => interval.kind === 'unknown'),
          summaryUnknown: summary?.timeline.some(interval => interval.kind === 'unknown'),
          locked: day?.intervals.some(interval => interval.kind === 'locked'),
          suspended: day?.intervals.some(interval => interval.kind === 'suspended'),
          inactive: document.querySelector('.activity-member__inactive')?.textContent.trim()
        }
      })()`)
    }
    if (coverageCase === 'lunch-unknown') {
      lunchGap = await evaluate(`(() => {
        const board = activityFixture.lastBoard
        return {
          unknown: board.members[0].day.intervals.filter(interval => interval.kind === 'unknown'),
          windows: board.calendar.windows
        }
      })()`)
    }
    if (coverageCase === 'point-only-diagnostic') {
      pointOnly = await evaluate(`(() => {
        const day = activityFixture.lastBoard.members[0].day
        return {
          incomplete: day.incomplete,
          rawUnknown: day.intervals.some(interval => interval.kind === 'unknown'),
          diagnosticCodes: day.diagnostics?.map(diagnostic => diagnostic.code) ?? []
        }
      })()`)
    }
  }
  assert.equal(syntheticGap.incomplete, true)
  assert.equal(syntheticGap.rawUnknown, false)
  assert.equal(syntheticGap.summaryUnknown, true)
  assert.equal(syntheticGap.locked, true)
  assert.equal(syntheticGap.suspended, true)
  assert.equal(syntheticGap.inactive, '1h:19m:25s')
  assert.equal(lunchGap.unknown.length, 1)
  assert.equal(lunchGap.unknown[0].start, Date.parse('2026-10-13T12:30:00+08:00'))
  assert.equal(lunchGap.unknown[0].end, Date.parse('2026-10-13T13:00:00+08:00'))
  assert.ok(
    lunchGap.windows.every(
      (window) => window.end <= lunchGap.unknown[0].start || window.start >= lunchGap.unknown[0].end
    )
  )
  assert.equal(pointOnly.incomplete, true)
  assert.equal(pointOnly.rawUnknown, false)
  assert.deepEqual(pointOnly.diagnosticCodes, ['clock-change'])

  await setActivityCoverageCase('two-second-unknown')
  await mount('coverage-two-second-unknown')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-coverage-warning')")
  assert.equal(
    await evaluate("document.querySelector('.activity-coverage-warning')?.textContent.trim()"),
    '有 2 秒 无法确认，未计入未活动。'
  )
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-coverage-warning')?.classList.contains('activity-warning')"
    ),
    true
  )
  await saveWarningScreenshot('activity-coverage-warning-two-seconds.png')

  await evaluate("activityFixture.setNow('2026-10-13T08:30:02+08:00')")
  await setActivityCoverageCase('bounded-two-second')
  await mount('coverage-bounded-two-second')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-coverage-warning')")
  assert.equal(
    await evaluate("document.querySelector('.activity-coverage-warning')?.textContent.trim()"),
    '有 2 秒 无法确认，未计入未活动。',
    'intersection uses both the calendar window and generatedAt cutoff'
  )

  await evaluate("activityFixture.setNow('2026-10-13T14:30:00+08:00')")
  await evaluate("activityFixture.setSettings({ locale: 'en-US' })")
  await setActivityCoverageCase('two-second-unknown')
  await mount('coverage-two-second-english')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-coverage-warning')")
  assert.equal(
    await evaluate("document.querySelector('.activity-coverage-warning')?.textContent.trim()"),
    'Unconfirmed: 2 s; excluded from inactive time.'
  )
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-coverage-warning')?.classList.contains('activity-warning')"
    ),
    true
  )
  await evaluate("activityFixture.setSettings({ locale: 'zh-CN' })")
  console.log(
    'PASS coverage warnings: raw unknown intersections, cutoff, translations, and excluded states'
  )
}

async function saveWarningScreenshot(name) {
  const screenshot = await new Promise((resolve) => {
    window.webContents.once('paint', (_event, _dirty, frame) => resolve(frame))
    window.webContents.invalidate()
  })
  await writeFile(join(directory, name), screenshot.toPNG())
}

async function clickWeekday(label) {
  await evaluate(
    "Array.from(document.querySelectorAll('.activity-week__day')).find(button => button.textContent.trim() === " +
      JSON.stringify(label) +
      ')?.click()'
  )
  await delay(80)
}

async function verifyDateRaceAndErrors() {
  await evaluate('activityFixture.holdBoard = true; activityFixture.dateNames = true')
  let start = await evaluate('activityFixture.requestedDates.length')
  await clickWeekday('周一')
  await waitFor(
    'activityFixture.requestedDates.length > ' +
      start +
      ' && document.querySelector(".activity[aria-busy=true]")'
  )
  assert.equal(await evaluate("document.querySelector('.activity-member') === null"), true)

  start = await evaluate('activityFixture.requestedDates.length')
  await clickWeekday('周二')
  await waitFor('activityFixture.requestedDates.length > ' + start)
  assert.equal(await evaluate('activityFixture.pending.length'), 2)
  await evaluate('activityFixture.holdBoard = false; activityFixture.pending.pop()()')
  await waitFor(
    "document.querySelector('.activity-member__name')?.textContent.includes('2026-10-13')"
  )
  await evaluate('activityFixture.release()')
  await delay(120)
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-member__name').textContent.includes('2026-10-13')"
    ),
    true,
    'late Monday response cannot overwrite the selected Tuesday'
  )
  await evaluate('activityFixture.dateNames = false')
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-week__day[aria-pressed=true]').textContent.trim()"
    ),
    '周二'
  )

  await evaluate("activityFixture.boardError = 'fixture-read-failure'")
  await clickWeekday('周一')
  await waitFor("document.querySelector('.activity-load-error')")
  assert.equal(await evaluate("document.querySelector('.activity-member') === null"), true)
  assert.equal(
    await evaluate("document.querySelector('.activity-load-error').textContent.includes('旧数据')"),
    false
  )
  await evaluate("activityFixture.boardError = ''")
  start = await evaluate('activityFixture.requestedDates.length')
  await clickText('重试')
  await waitFor(
    'activityFixture.requestedDates.length > ' +
      start +
      ' && document.querySelector(".activity-member")'
  )
  console.log(
    'PASS board requests: date race drops stale data; failed reads retry without another date’s data'
  )
}

async function selectAndWait(label, date) {
  const previous = await evaluate('activityFixture.requestedDates.length')
  await clickWeekday(label)
  await waitFor(
    'activityFixture.requestedDates.length > ' +
      previous +
      ' && activityFixture.requestedDates.slice(' +
      previous +
      ').includes(' +
      JSON.stringify(date) +
      ')'
  )
}

async function verifyBoardStates() {
  await evaluate('activityFixture.empty = true')
  await selectAndWait('周二', '2026-10-13')
  await waitFor("document.querySelector('.activity-members .activity-empty')")
  assert.equal(await evaluate("document.querySelector('.activity-member') === null"), true)

  await evaluate('activityFixture.empty = false; activityFixture.noDay = true')
  await selectAndWait('周一', '2026-10-12')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickSelector('.activity-member__toggle')
  await waitFor(
    "document.querySelector('.activity-member .activity-empty')?.textContent.includes('暂无记录')"
  )
  assert.equal(
    await evaluate("document.querySelector('.activity-member .activity-timeline') === null"),
    true
  )

  await evaluate('activityFixture.noDay = false; activityFixture.missingCalendar = true')
  await selectAndWait('周二', '2026-10-13')
  await waitFor(
    "document.querySelector('.activity-warning')?.textContent.includes('工作日数据暂不可用')"
  )
  assert.equal(await evaluate("document.querySelector('.activity-member') === null"), true)
  await evaluate('activityFixture.missingCalendar = false')
  console.log('PASS board states: empty team, no recorded day, missing calendar')
}

async function verifyWeekendAndAdjustedWorkday() {
  await evaluate("activityFixture.setNow('2026-10-11T14:30:00+08:00')")
  await mount('weekend-sunday')
  await waitFor("document.querySelector('.activity-empty')?.textContent.includes('非工作日')")
  assert.equal(await evaluate("document.querySelector('.activity-member') === null"), true)
  await selectAndWait('周六', '2026-10-10')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-timeline')")
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-week__day[aria-pressed=true]').textContent.trim()"
    ),
    '周六'
  )
  console.log('PASS calendar: Sunday is a rest day; adjusted Saturday has a timeline')
}

async function verifyWeekPolling() {
  await evaluate("activityFixture.setNow('2026-10-11T23:59:55+08:00')")
  const start = await evaluate('activityFixture.requestedDates.length')
  await mount('week-poll')
  await waitFor(
    "document.querySelector('.activity-week__day[aria-current=date]')?.textContent.trim() === '周日'"
  )
  await waitFor('activityFixture.requestedDates.slice(' + start + ').includes("2026-10-11")')

  const calls = await evaluate('activityFixture.boardCalls')
  await evaluate("activityFixture.setNow('2026-10-12T00:00:05+08:00')")
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-week__day[aria-current=date]').textContent.trim()"
    ),
    '周日',
    'setNow does not render immediately'
  )
  assert.equal(await evaluate('activityFixture.boardCalls'), calls)
  await delay(9_000)
  await waitFor(
    "document.querySelector('.activity-week__day[aria-current=date]')?.textContent.trim() === '周一' && " +
      "document.querySelector('.activity-week__day[aria-pressed=true]')?.textContent.trim() === '周一' && " +
      'activityFixture.requestedDates.slice(' +
      start +
      ').includes("2026-10-12")',
    150
  )
  console.log(
    'PASS week polling: Sunday to Monday rollover reloads October 12 after the 10-second poll'
  )
}

async function verifyCrossYearMapping() {
  await evaluate("activityFixture.setNow('2026-01-01T12:00:00+08:00')")
  const start = await evaluate('activityFixture.requestedDates.length')
  await mount('cross-year')
  await waitFor(
    "document.querySelector('.activity-week__day[aria-current=date]')?.textContent.trim() === '周四'"
  )
  await selectAndWait('周一', '2025-12-29')
  await waitFor(
    "document.querySelector('.activity-warning')?.textContent.includes('工作日数据暂不可用')"
  )
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-week__day[aria-pressed=true]').textContent.trim()"
    ),
    '周一'
  )
  assert.equal(
    await evaluate('activityFixture.requestedDates.slice(' + start + ').includes("2025-12-29")'),
    true
  )
  console.log('PASS cross-year mapping: January 1 week starts on Monday December 29')
}

async function verifyVisibilityPolling() {
  await evaluate("activityFixture.setNow('2026-10-13T14:30:00+08:00')")
  await evaluate("activityFixture.setSettings({ locale: 'zh-CN' })")
  await mount('visibility-polling')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickWeekday('周一')
  await waitFor(
    "document.querySelector('.activity-week__day[aria-pressed=true]')?.textContent.trim() === '周一'"
  )
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-member__toggle[aria-expanded=true]')")
  await evaluate(`(() => {
    activityFixture.visibilityChanges = []
    window.codexStatus.onPanelVisibilityChanged(visible => {
      activityFixture.visibilityChanges.push(visible ? 'visible' : 'hidden')
    })
  })()`)

  await verifyHiddenBoardCalls()
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-week__day[aria-pressed=true]')?.textContent.trim()"
    ),
    '周一',
    'show preserves selected date'
  )
  assert.equal(
    await evaluate(
      "document.querySelector('.activity-member__toggle')?.getAttribute('aria-expanded')"
    ),
    'true',
    'show preserves expanded member details'
  )
  assert.equal(await evaluate('activityFixture.requestedDates.at(-1)'), '2026-10-12')
  const shownCalls = await evaluate('activityFixture.boardCalls')
  await delay(RESTORED_POLL_WAIT_MS)
  assert.equal(
    await evaluate('activityFixture.boardCalls'),
    shownCalls + 1,
    'show restores one 10-second poll'
  )
  console.log(
    'PASS native Electron visibility IPC: hidden for 30 seconds makes no board calls; show refreshes immediately, restores one poll, and preserves selection/details'
  )
}

async function verifyHiddenBoardCalls() {
  window.webContents.setBackgroundThrottling(false)
  window.showInactive()
  await waitFor('document.visibilityState === "visible"')
  window.hide()
  window.webContents.setBackgroundThrottling(true)
  await waitFor('activityFixture.visibilityChanges.at(-1) === "hidden"')
  assert.equal(window.isVisible(), false)
  const hiddenCalls = await evaluate('activityFixture.boardCalls')
  await delay(HIDDEN_POLL_WAIT_MS)
  assert.equal(await evaluate('activityFixture.boardCalls'), hiddenCalls, 'hidden for 30 seconds')
  window.webContents.setBackgroundThrottling(false)
  window.showInactive()
  await waitFor(
    'activityFixture.visibilityChanges.at(-1) === "visible" && activityFixture.boardCalls > ' +
      hiddenCalls
  )
}

async function verifyThemeConsistency(themes) {
  await evaluate("activityFixture.setNow('2026-10-13T14:30:00+08:00')")
  await evaluate(
    'activityFixture.empty = false; activityFixture.noDay = false; activityFixture.missingCalendar = false; activityFixture.boardError = ""; activityFixture.coverageCase = "two-second-unknown"'
  )
  await evaluate('activityFixture.setSettings({ activityIdleThresholdMinutes: 5 })')
  await mount('app')
  await waitFor("document.querySelector('.activity-tabs')")
  await clickText('管理')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await clickSelector('.activity-member__toggle')
  await waitFor("document.querySelector('.activity-timeline')")
  await evaluate(`(() => {
    const reference = document.createElement('div')
    reference.className = 'activity-theme-reference'
    reference.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none'
    reference.innerHTML = '<section class="settings-section"></section>' +
      '<button class="detail-row window-keeper-row is-expanded"><span class="detail-row__label">测试成员甲</span><span class="detail-row__value-group"><span class="detail-row__hint">1h:19m:25s</span></span></button>' +
      '<div class="segmented"><button>周一</button><button class="is-active">周二</button><button>周三</button><button>周四</button><button>周五</button><button>周六</button><button>周日</button></div>' +
      '<div class="team-mode-switch"><div class="segmented"><button>排行榜</button><button class="is-active">管理</button></div></div>' +
      '<div class="quota-card__progress"></div>' +
      '<p class="activity-warning activity-theme-warning">无法确认</p>'
    document.querySelector('.panel').append(reference)
  })()`)

  const measurements = []
  for (const locale of ['zh-CN', 'en-US']) {
    for (const width of [360, 480, 900]) {
      window.setContentSize(width, 1000)
      for (const theme of themes) {
        await evaluate(
          'activityFixture.setSettings({ theme: ' +
            JSON.stringify(theme) +
            ', locale: ' +
            JSON.stringify(locale) +
            ' })'
        )
        await evaluate(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
        )
        await evaluate(
          "Promise.all(document.querySelector('.panel').getAnimations().map(animation => animation.finished))"
        )
        await checkThemeAtSize(theme, locale, width, measurements)
      }
    }
  }
  await writeFile(join(directory, 'measurements.json'), JSON.stringify(measurements, null, 2))
  console.log('PASS themes: 10 themes, 2 languages, widths 360/480/900; screenshots: ' + directory)
}

async function checkThemeAtSize(theme, locale, width, measurements) {
  const result = await evaluate(`(() => {
    const content = document.querySelector('.panel__content')
    const overflowElements = Array.from(document.querySelectorAll('.activity *')).filter(element => {
      if (!element.getClientRects().length) return false
      const rect = element.getBoundingClientRect(), bounds = content.getBoundingClientRect()
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ||
        (element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).display !== 'inline' && getComputedStyle(element).textOverflow !== 'ellipsis')
    })
    const overflow = overflowElements.map(element => element.className || element.tagName)
    const overflowDetails = overflowElements.map(element => ({
      className: element.className || element.tagName,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      children: Array.from(element.children).map(child => ({
        className: child.className || child.tagName,
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth,
        left: child.getBoundingClientRect().left,
        right: child.getBoundingClientRect().right
      }))
    }))
    const tickOverlap = Array.from(document.querySelectorAll('.activity-timeline__axis')).some(axis => {
      const labels = Array.from(axis.children).map(label => label.getBoundingClientRect()).sort((a,b) => a.left-b.left)
      return labels.some((label,index) => index > 0 && label.left < labels[index-1].right + 1)
    })
    const pick = (element, names) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(names.map(name => [name, style[name]]))
    }
    const cardNames = ['borderRadius', 'borderWidth', 'borderColor', 'backgroundImage', 'backgroundColor', 'boxShadow']
    const selectedNames = [...cardNames, 'color', 'fontFamily', 'fontWeight', 'letterSpacing']
    const reference = document.querySelector('.activity-theme-reference')
    const tabs = document.querySelector('.activity-tabs').getBoundingClientRect()
    const switchBounds = document.querySelector('.activity-tabs .segmented').getBoundingClientRect()
    const tabNames = [...selectedNames, 'fontSize', 'padding', 'minHeight']
    const memberName = document.querySelector('.activity-member__name')
    const memberDuration = document.querySelector('.activity-member__inactive')
    const memberRow = document.querySelector('.activity-member__toggle')
    return {
      overflow,
      overflowDetails,
      hasThresholdSettings: !!document.querySelector('.activity-advanced, .activity-threshold'),
      tickOverlap,
      nameLines: Math.max(...Array.from(document.querySelectorAll('.activity-member__name'))
        .map(element => element.offsetHeight / parseFloat(getComputedStyle(element).lineHeight))),
      fullNames: Array.from(document.querySelectorAll('.activity-member__name')).every(element => element.title === element.textContent.trim()),
      sameMemberLine: Math.abs(memberName.offsetTop + memberName.offsetHeight / 2 - memberDuration.offsetTop - memberDuration.offsetHeight / 2) <= 2,
      memberPadding: getComputedStyle(memberRow).paddingTop,
      memberMinHeight: getComputedStyle(memberRow).minHeight,
      durationWidths: Array.from(document.querySelectorAll('.activity-member__inactive')).map(element => element.offsetWidth),
      memberCountTitle: document.querySelector('.activity-members__heading .settings-section__title')?.textContent.trim(),
      memberCountRows: document.querySelectorAll('.activity-members .activity-member').length,
      segments: document.querySelectorAll('.activity-segment').length,
      inactiveFills: Array.from(document.querySelectorAll('.activity-pattern--inactive'))
        .map(element => getComputedStyle(element).backgroundImage),
      section: pick(document.querySelector('.activity-members'), cardNames),
      referenceSection: pick(reference.querySelector('.settings-section'), cardNames),
      card: pick(document.querySelector('.activity-member__toggle'), cardNames),
      referenceCard: pick(reference.querySelector('.detail-row'), cardNames),
      name: pick(document.querySelector('.activity-member__name'), ['fontWeight', 'color', 'fontFamily']),
      referenceName: pick(reference.querySelector('.detail-row__label'), ['fontWeight', 'color', 'fontFamily']),
      value: pick(document.querySelector('.activity-member__inactive'), ['fontWeight', 'fontSize', 'color', 'fontFamily']),
      referenceValue: pick(reference.querySelector('.detail-row__hint'), ['fontWeight', 'fontSize', 'color', 'fontFamily']),
      warning: pick(document.querySelector('.activity-coverage-warning'), ['color', 'fontSize']),
      referenceWarning: pick(reference.querySelector('.activity-theme-warning'), ['color', 'fontSize']),
      coverageText: document.querySelector('.activity-coverage-warning')?.textContent.trim() ?? '',
      band: pick(document.querySelector('.activity-timeline__band'), cardNames),
      referenceBand: pick(reference.querySelector('.quota-card__progress'), cardNames),
      selected: pick(document.querySelector('.activity-week__day.is-active'), selectedNames),
      referenceSelected: pick(reference.querySelector('.segmented button.is-active'), selectedNames)
      ,tabs: pick(document.querySelector('.activity-tabs .segmented button.is-active'), tabNames)
      ,referenceTabs: pick(reference.querySelector('.team-mode-switch .segmented button.is-active'), tabNames)
      ,tabsRightGap: Math.abs(tabs.right - switchBounds.right)
      ,tabsWidthRatio: switchBounds.width / tabs.width
    }
  })()`)
  const label = theme + '/' + locale + '/' + width
  assert.deepEqual(
    result.overflow,
    [],
    label + ': horizontal overflow ' + JSON.stringify(result.overflowDetails)
  )
  assert.equal(result.hasThresholdSettings, false, label + ': threshold settings must be removed')
  assert.equal(result.tickOverlap, false, label + ': timeline labels overlap')
  assert.equal(
    result.memberCountTitle,
    locale === 'zh-CN' ? '成员（3）' : 'Members (3)',
    label + ': member count title must use the selected language'
  )
  assert.equal(result.memberCountRows, 3, label + ': count must match the displayed member rows')
  assert.equal(
    result.coverageText,
    locale === 'zh-CN'
      ? '有 2 秒 无法确认，未计入未活动。'
      : 'Unconfirmed: 2 s; excluded from inactive time.',
    label + ': coverage warning must use the selected language'
  )
  assert.ok(result.nameLines <= 1.2, label + ': duration must not squeeze the member name')
  assert.equal(
    result.fullNames,
    true,
    label + ': clipped member names must retain their full title'
  )
  assert.equal(result.sameMemberLine, true, label + ': name and duration must stay on one row')
  assert.equal(result.memberPadding, '8px', label + ': member rows must use compact padding')
  assert.equal(
    result.memberMinHeight,
    '0px',
    label + ': member rows must not retain the original 50px minimum'
  )
  assert.equal(
    new Set(result.durationWidths).size,
    1,
    label + ': duration columns must have equal width'
  )
  assert.ok(result.segments > 0, label + ': timeline is empty')
  assert.ok(
    result.inactiveFills.length > 0 && result.inactiveFills.every((fill) => fill !== 'none'),
    label + ': inactive legend and intervals must have a visible fill'
  )
  assert.deepEqual(
    result.section,
    result.referenceSection,
    label + ': section theme differs from settings'
  )
  assert.deepEqual(
    result.card,
    result.referenceCard,
    label + ': member theme differs from details row'
  )
  assert.deepEqual(
    result.band,
    result.referenceBand,
    label + ': timeline theme differs from details progress'
  )
  assert.deepEqual(result.name, result.referenceName, label + ': member name theme differs')
  assert.deepEqual(result.value, result.referenceValue, label + ': inactive duration theme differs')
  assert.deepEqual(result.warning, result.referenceWarning, label + ': warning theme differs')
  assert.deepEqual(
    result.tabs,
    result.referenceTabs,
    label + ': team tabs differ from ranking modes'
  )
  assert.ok(
    result.tabsRightGap <= 1 && result.tabsWidthRatio < 0.75,
    label + ': team tabs must be compact and right aligned'
  )
  assert.deepEqual(
    result.selected,
    result.referenceSelected,
    label + ': selected weekday theme differs'
  )
  measurements.push({ theme, locale, width, ...result })

  if (locale === 'zh-CN') {
    await delay(80)
    const screenshot = await new Promise((resolve) => {
      window.webContents.once('paint', (_event, _dirty, frame) => resolve(frame))
      window.webContents.invalidate()
    })
    await writeFile(join(directory, theme + '-' + width + '.png'), screenshot.toPNG())
    const pixels = screenshot.toBitmap()
    const colors = new Set()
    for (let index = 0; index + 4 <= pixels.length; index += 64)
      colors.add(pixels.readUInt32LE(index))
    assert.ok(colors.size > 12, label + ': screenshot must not be blank; colors=' + colors.size)
    if (width === 480) {
      await clickSelector('.activity-member__toggle')
      assert.equal(await evaluate("document.querySelector('.activity-timeline') === null"), true)
      await evaluate(`Promise.all(Array.from(document.querySelectorAll('.window-keeper-row__chevron'))
        .flatMap(element => element.getAnimations().map(animation => animation.finished)))`)
      const collapsed = await new Promise((resolve) => {
        window.webContents.once('paint', (_event, _dirty, frame) => resolve(frame))
        window.webContents.invalidate()
      })
      await writeFile(join(directory, theme + '-480-collapsed.png'), collapsed.toPNG())
      await clickSelector('.activity-member__toggle')
    }
  }
}

async function run() {
  console.log('STEP build isolated fixture')
  const visibilityBundle = await build({
    stdin: {
      contents:
        "export { getPanelVisibility, subscribePanelVisibility } from './src/main/services/panel-visibility.ts'; export { ACTIVITY_CHANNELS } from './src/shared/activity.ts'",
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  const { getPanelVisibility, subscribePanelVisibility, ACTIVITY_CHANNELS } = await import(
    `data:text/javascript;base64,${Buffer.from(visibilityBundle.outputFiles[0].text).toString('base64')}`
  )
  const visibilityPreload = join(directory, 'visibility-preload.cjs')
  await writeFile(
    visibilityPreload,
    `
    const { contextBridge, ipcRenderer } = require('electron')
    contextBridge.exposeInMainWorld('activityVisibility', {
      getPanelVisibility: () => ipcRenderer.invoke(${JSON.stringify(ACTIVITY_CHANNELS.panelVisibility)}),
      onPanelVisibilityChanged: listener => {
        const channel = ${JSON.stringify(ACTIVITY_CHANNELS.panelVisibilityChanged)}
        const handle = (_event, visible) => listener(visible)
        ipcRenderer.on(channel, handle)
        return () => ipcRenderer.removeListener(channel, handle)
      }
    })
  `
  )
  const styles =
    (await cssTree(join(root, 'src/renderer/src/assets/main.css'))) +
    (await cssTree(join(root, 'src/renderer/src/assets/themes.css')))
  const bundle = await build({
    entryPoints: [join(root, 'scripts/fixtures/activity-renderer.jsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  await writeFile(join(directory, 'fixture.js'), bundle.outputFiles[0].text)
  const htmlFile = join(directory, 'fixture.html')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>`
  await writeFile(htmlFile, html)
  console.log('STEP create isolated Electron window')
  await app.whenReady()
  window = new BrowserWindow({
    show: false,
    width: 480,
    height: 1000,
    webPreferences: {
      preload: visibilityPreload,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true
    }
  })
  subscribePanelVisibility(window)
  ipcMain.handle(ACTIVITY_CHANNELS.panelVisibility, (event) =>
    getPanelVisibility(window, event.sender.id)
  )
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') errors.push(event.message)
  })
  await window.loadURL(pathToFileURL(htmlFile).href)
  window.setOpacity(0)
  window.showInactive()
  await mount('app')
  await waitFor(
    "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '管理')"
  )
  assert.equal(await evaluate('activityFixture.settings().activityEnabled'), true)
  await clickText('管理')
  await waitFor("document.querySelector('.activity-member__toggle')")
  await verifyActivityWeek()
  await verifyFixedThreshold()
  await verifyAppRoutesAndPolling()
  await verifyTeamAdminAuthorization()
  await verifyMemberSorting()
  await verifyMemberCounts()
  await verifyPanelDetailsAndTooltip()
  await verifyActivityCoverageWarnings()
  await verifyDateRaceAndErrors()
  await verifyBoardStates()
  await verifyWeekendAndAdjustedWorkday()
  await verifyWeekPolling()
  await verifyCrossYearMapping()
  const themes = await evaluate('activityFixture.themes')
  assert.equal(themes.length, 10)
  await verifyThemeConsistency(themes)
  await verifyVisibilityPolling()
  assert.deepEqual(errors, [])
  console.log('Activity UI checks passed. Isolated fixture: ' + htmlFile)
}

run().then(
  () => {
    clearTimeout(watchdog)
    window?.destroy()
    app.quit()
  },
  (error) => {
    console.error(error)
    clearTimeout(watchdog)
    window?.destroy()
    app.exit(1)
  }
)
