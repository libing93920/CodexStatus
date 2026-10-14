/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { TeamActivityService } from '../src/main/services/team-activity.ts'
import { recentWorkDates, workDayStart } from '../src/shared/work-time.ts'

const NOW = Date.parse('2026-10-14T18:00:00+08:00')
const TEAM = '123456abcdef'
const ADMIN = '20000000-0000-4000-8000-000000000001'
const MEMBER_COUNTS = [10, 30, 100]
const INTERVAL_COUNT = 120
const INTERVAL_MS = 30_000
const WORK_START_MS = 9 * 60 * 60 * 1_000
const SAMPLE_COUNT = 8
const EVENT_LOOP_SETTLE_MS = 10

function createService(memberCount) {
  const peers = Array.from({ length: memberCount }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    nickname: `member-${index}`,
    activitySupported: true,
    activityEnabled: true
  }))
  const service = new TeamActivityService({
    directory: 'memory-only-activity-benchmark',
    now: () => NOW,
    transport: {
      getPeers: () => peers,
      getActivityAdminIds: () => [],
      sendActivity: () => true
    },
    readInput: () => ({ idleSeconds: 0, kind: 'idle' })
  })
  service.config = {
    team: TEAM,
    peerId: ADMIN,
    nickname: 'admin',
    enabled: false,
    admin: true,
    thresholdMinutes: 5
  }
  for (const peer of peers) {
    for (const date of recentWorkDates(NOW)) {
      service.store.stage(createDay(peer, date))
    }
  }
  return service
}

function createDay(peer, date) {
  const start = workDayStart(date) + WORK_START_MS
  return {
    version: 1,
    team: TEAM,
    peerId: peer.id,
    nickname: peer.nickname,
    date,
    revision: 1,
    calendarVersion: 'fixture',
    observedAt: start + INTERVAL_COUNT * INTERVAL_MS,
    incomplete: false,
    intervals: Array.from({ length: INTERVAL_COUNT }, (_, index) => ({
      start: start + index * INTERVAL_MS,
      end: start + (index + 1) * INTERVAL_MS,
      kind: index % 2 ? 'active' : 'idle'
    }))
  }
}

async function benchmark(memberCount) {
  const service = createService(memberCount)
  const date = recentWorkDates(NOW)[0]
  service.getBoard(date)
  const eventLoop = monitorEventLoopDelay({ resolution: 1 })
  eventLoop.enable()
  await delay(EVENT_LOOP_SETTLE_MS)
  const clone = globalThis.structuredClone
  let copies = 0
  let board
  const samples = []
  globalThis.structuredClone = (value) => {
    copies++
    return clone(value)
  }
  try {
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const startedAt = performance.now()
      board = service.getBoard(date)
      samples.push(performance.now() - startedAt)
    }
  } finally {
    globalThis.structuredClone = clone
  }
  await delay(EVENT_LOOP_SETTLE_MS)
  eventLoop.disable()
  samples.sort((left, right) => left - right)
  return {
    memberCount,
    days: recentWorkDates(NOW).length,
    intervalsPerDay: INTERVAL_COUNT,
    samples: SAMPLE_COUNT,
    p50Ms: Number(samples[Math.floor(SAMPLE_COUNT / 2)].toFixed(2)),
    p95Ms: Number(samples.at(-1).toFixed(2)),
    copiesPerQuery: copies / SAMPLE_COUNT,
    eventLoopBatchMaxMs: Number((eventLoop.max / 1_000_000).toFixed(2)),
    returnedMembers: board.members.length,
    boardJsonBytes: Buffer.byteLength(JSON.stringify(board))
  }
}

console.log(JSON.stringify({ node: process.version, date: '2026-10-14', memoryOnly: true }))
for (const memberCount of MEMBER_COUNTS) {
  console.log(JSON.stringify(await benchmark(memberCount)))
}
