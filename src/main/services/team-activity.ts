import path from 'node:path'
import {
  ACTIVITY_LIVE_MS,
  ACTIVITY_SYNC_MS,
  normalizeIdleThreshold,
  summarizeActivity,
  validateActivityMessage,
  type ActivityBoard,
  type ActivityLive,
  type ActivityMember,
  type ActivityMessage,
  type WorkCalendarStatus
} from '../../shared/activity.ts'
import { isRetainedWorkDate, recentWorkDates, workDateKey } from '../../shared/work-time.ts'
import type { ActivitySample } from '../../shared/activity-recorder.ts'
import type { LanService } from './lan'
import { ActivityStore } from './activity-store.ts'
import { WorkCalendarService } from './work-calendar.ts'
import { ActivityMonitor, type ActivityMonitorConfig } from './activity-monitor.ts'

interface ActivityConfig extends ActivityMonitorConfig {
  admin: boolean
  thresholdMinutes: number
}
interface ServiceOptions {
  directory: string
  transport: Pick<LanService, 'getPeers' | 'getActivityAdminIds' | 'sendActivity'>
  readInput: () => Pick<ActivitySample, 'idleSeconds' | 'kind'>
  now?: () => number
  monotonic?: () => number
  fetcher?: typeof fetch
}

export class TeamActivityService {
  private readonly options: ServiceOptions
  private readonly store: ActivityStore
  private readonly calendar: WorkCalendarService
  private readonly monitor: ActivityMonitor
  private config: ActivityConfig | undefined
  private generation = 0
  private timer: NodeJS.Timeout | undefined
  private readonly livePeers = new Map<string, { live: ActivityLive; receivedAt: number }>()
  private readonly lastRequests = new Map<string, number>()
  private readonly responding = new Set<string>()
  private lastPrunedDate = ''
  private pendingPrune: Promise<void> | undefined

  constructor(options: ServiceOptions) {
    this.options = options
    this.store = new ActivityStore(path.join(options.directory, 'days'), options.now)
    this.calendar = new WorkCalendarService(options.directory, options.fetcher, options.now)
    this.monitor = new ActivityMonitor({
      store: this.store,
      calendar: this.calendar,
      readInput: options.readInput,
      now: options.now,
      monotonic: options.monotonic
    })
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    await this.calendar.initialize()
  }

  configure(config: ActivityConfig): void {
    const changedTeam = this.config?.team !== config.team
    if (
      changedTeam ||
      this.config?.peerId !== config.peerId ||
      this.config?.admin !== config.admin ||
      this.config?.enabled !== config.enabled
    )
      this.generation++
    if (changedTeam || (this.config?.admin && !config.admin)) {
      this.livePeers.clear()
      this.lastRequests.clear()
    }
    this.config = { ...config, thresholdMinutes: normalizeIdleThreshold(config.thresholdMinutes) }
    this.monitor.configure(config)
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (!config.team || (!config.enabled && !config.admin)) return
    this.pulse()
    this.timer = setInterval(() => this.pulse(), ACTIVITY_LIVE_MS)
    this.timer.unref()
  }

  onPeersChanged(): void {
    const ids = new Set(this.options.transport.getPeers().map((peer) => peer.id))
    for (const id of this.lastRequests.keys()) if (!ids.has(id)) this.lastRequests.delete(id)
    for (const id of this.livePeers.keys()) if (!ids.has(id)) this.livePeers.delete(id)
    this.requestDays()
  }

  async receive(peerId: string, message: ActivityMessage): Promise<void> {
    if (!this.config?.team || !validateActivityMessage(message, this.now())) return
    if (message.type === 'activity-request') {
      if (!this.config.enabled || this.responding.has(peerId)) return
      this.responding.add(peerId)
      try {
        await this.respondWithDays(peerId, message.revisions)
      } finally {
        this.responding.delete(peerId)
      }
      return
    }
    if (!this.config.admin) return
    const peer = this.options.transport.getPeers().find((item) => item.id === peerId)
    if (!peer?.activitySupported || peer.activityEnabled !== true) return
    if (message.type === 'activity-day') {
      if (message.day.team !== this.config.team || message.day.peerId !== peerId) return
      const generation = this.generation
      await this.store.save(message.day)
      if (generation !== this.generation || !this.config?.admin) return
      const currentPeer = this.options.transport.getPeers().find((item) => item.id === peerId)
      if (!currentPeer?.activitySupported || !currentPeer.activityEnabled) return
      this.options.transport.sendActivity(peerId, {
        type: 'activity-ack',
        date: message.day.date,
        revision: message.day.revision
      })
    } else if (message.type === 'activity-live') {
      const { observedAt, state, idleSince, lastInputAt, enabled } = message.live
      this.livePeers.set(peerId, {
        live: { observedAt, state, idleSince, lastInputAt, enabled },
        receivedAt: this.now()
      })
    }
  }

  getBoard(date: string): ActivityBoard {
    if (!this.config?.admin || !this.config.team) throw new Error('仅团队管理员可以查看活动统计')
    if (!isRetainedWorkDate(date, this.now())) throw new Error('请选择近30天的有效日期')
    const config = this.config
    const calendar = this.calendar.getStatus(date)
    const members = this.getMembers(date)
    this.decorateMembers(members, calendar)
    return {
      date,
      generatedAt: this.now(),
      thresholdMinutes: config.thresholdMinutes,
      calendar,
      members,
      issues: [...this.store.issues].slice(-6)
    }
  }

  async refreshCalendar(): Promise<WorkCalendarStatus> {
    if (!this.config?.admin || !this.config.team) throw new Error('仅团队管理员可以更新团队日历')
    const generation = this.generation
    await this.calendar.refresh(true)
    if (generation !== this.generation || !this.config?.admin || !this.config.team)
      throw new Error('团队角色已变化，请重新打开管理页')
    this.monitor.tick()
    return this.calendar.getStatus(workDateKey(this.now()))
  }

  async systemEvent(event: 'lock' | 'unlock' | 'suspend' | 'resume'): Promise<void> {
    await this.monitor.systemEvent(event)
  }

  async stop(): Promise<void> {
    this.generation++
    this.config = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await Promise.all([this.monitor.stop(), this.calendar.flush(), this.pendingPrune])
  }

  report(error: unknown): void {
    this.store.issues.add(
      `活动同步不完整：${error instanceof Error ? error.message : String(error)}`
    )
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private getMembers(date: string): ActivityMember[] {
    const config = this.config!
    const members = new Map<string, ActivityMember>()
    for (const { day, receivedAt } of this.store.list(config.team, date)) {
      const isSelf = day.peerId === config.peerId
      members.set(day.peerId, {
        id: day.peerId,
        nickname: isSelf ? config.nickname : day.nickname,
        isSelf,
        online: isSelf,
        supported: true,
        enabled: isSelf ? config.enabled : undefined,
        day,
        receivedAt
      })
    }
    for (const peer of this.options.transport.getPeers()) {
      const member = members.get(peer.id)
      if (!member) continue
      Object.assign(member, {
        nickname: peer.nickname,
        online: true,
        supported: peer.activitySupported === true,
        enabled: peer.activityEnabled
      })
    }
    return [...members.values()]
  }

  private pulse(): void {
    if (!this.config?.team) return
    void this.calendar.refresh().catch((error: unknown) => this.report(error))
    if (this.config.enabled) {
      const live = this.monitor.getLive()
      for (const peerId of this.options.transport.getActivityAdminIds())
        this.options.transport.sendActivity(peerId, { type: 'activity-live', live })
    }
    this.requestDays()
    const date = workDateKey(this.now())
    if (this.lastPrunedDate === date) return
    this.lastPrunedDate = date
    this.pendingPrune = this.store.prune().catch((error: unknown) => this.report(error))
  }

  private requestDays(): void {
    if (!this.config?.admin || !this.config.team) return
    const now = this.now()
    for (const peer of this.options.transport.getPeers()) {
      if (
        !peer.activitySupported ||
        !peer.activityEnabled ||
        now - (this.lastRequests.get(peer.id) ?? 0) < ACTIVITY_SYNC_MS
      )
        continue
      const revisions = Object.fromEntries(
        recentWorkDates(now).map((date) => [
          date,
          this.store.getRevision(this.config!.team, peer.id, date)
        ])
      )
      if (this.options.transport.sendActivity(peer.id, { type: 'activity-request', revisions }))
        this.lastRequests.set(peer.id, now)
    }
  }

  private async respondWithDays(peerId: string, revisions: Record<string, number>): Promise<void> {
    const config = this.config!
    for (const [date, revision] of Object.entries(revisions).sort(([left], [right]) =>
      right.localeCompare(left)
    )) {
      if (
        !this.config?.enabled ||
        this.config.team !== config.team ||
        !this.options.transport.getActivityAdminIds().includes(peerId)
      )
        return
      if (this.store.getRevision(config.team, config.peerId, date) <= revision) continue
      const day = this.store.get(config.team, config.peerId, date)!.day
      await this.store.save(day)
      if (!this.config?.enabled || this.config.team !== config.team) return
      this.options.transport.sendActivity(peerId, { type: 'activity-day', day })
    }
  }

  private decorateMembers(members: ActivityMember[], calendar: WorkCalendarStatus): void {
    for (const member of members) {
      if (member.day && calendar.available) {
        member.summary = summarizeActivity(
          member.day,
          calendar.windows,
          this.config!.thresholdMinutes,
          this.now()
        )
        member.calendarMismatch = member.day.calendarVersion !== calendar.version
      }
      const remote = this.livePeers.get(member.id)
      const live = member.isSelf ? this.monitor.getLive() : remote?.live
      if (!live) continue
      member.live = { ...live }
      if (remote) member.receivedAt = Math.max(member.receivedAt ?? 0, remote.receivedAt)
      if (
        live.state === 'idle' &&
        live.idleSince !== undefined &&
        live.observedAt - live.idleSince < this.config!.thresholdMinutes * 60_000
      )
        member.live.state = 'active'
    }
  }
}
