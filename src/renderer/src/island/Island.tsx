import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  createEmptyIslandSnapshot,
  getDisplayStatus,
  ISLAND_ALERT_DURATION_MS,
  PausableReminder,
  type IslandDisplayStatus,
  type IslandPresentation,
  type IslandSnapshot,
  type IslandTask
} from '../../../shared/island'
import './island.css'
import { useIslandDiagnostics } from './use-island-diagnostics'

type IslandMode = 'hidden' | 'compact' | 'alert' | 'expanded'

const STATUS_COPY: Record<IslandDisplayStatus, string> = {
  'waiting-approval': '需要审批',
  'waiting-input': '需要回复',
  running: '执行中',
  completed: '任务完成',
  failed: '任务失败',
  stopped: '已停止'
}
const ALERT_STATUSES: readonly IslandDisplayStatus[] = [
  'waiting-approval',
  'waiting-input',
  'failed',
  'completed'
]
const HOLD_DURATION_MS = 450
const EXIT_DURATION_MS = 340

export default function Island(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<IslandSnapshot>(createEmptyIslandSnapshot)
  const [mode, setModeState] = useState<IslandMode>('hidden')
  const [alertTask, setAlertTask] = useState<IslandTask>()
  const [presentation, setPresentation] = useState<IslandPresentation>({
    revision: 0,
    visible: false
  })
  const [rendererReady, setRendererReady] = useState(false)
  const [navigationError, setNavigationError] = useState('')
  const [now, setNow] = useState(Date.now())
  const latestSnapshot = useRef<IslandSnapshot>(createEmptyIslandSnapshot())
  const presentationRef = useRef(false)
  const seenEvents = useRef(new Set<string>())
  const reminder = useRef<PausableReminder | undefined>(undefined)
  const exitTimer = useRef<number | undefined>(undefined)
  const hovering = useRef(false)
  const focused = useRef(false)
  const holdTimer = useRef<number | undefined>(undefined)
  const modeRef = useRef<IslandMode>('hidden')
  const alertRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const startReminderRef = useRef<() => void>(() => undefined)
  const finishAlertRef = useRef<(reason: string) => void>(() => undefined)
  const pauseReminderRef = useRef<() => void>(() => undefined)
  const resumeReminderRef = useRef<() => void>(() => undefined)
  const presentationHandlerRef = useRef<(next: IslandPresentation) => void>(() => undefined)
  const cancelInteractiveFrameRef = useRef<() => void>(() => undefined)
  const alertEvent = alertTask ? alertEventId(alertTask) : undefined
  const diagnostic = useIslandDiagnostics({ mode, modeRef, presentation, hovering, focused })

  function setMode(next: IslandMode, reason: string): void {
    diagnostic.request(next, reason)
    setModeState(next)
  }

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    let active = true
    void window.codexStatus.bootstrap().then((payload) => {
      if (!active) return
      diagnostic.buffer.setEnabled(payload.islandDiagnostics)
      diagnostic.trace('ready', {
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      })
      latestSnapshot.current = payload.island
      setSnapshot(payload.island)
      setMode('hidden', 'bootstrap')
      setRendererReady(true)
    })
    const disposeIsland = window.codexStatus.onIslandUpdated((next) => {
      latestSnapshot.current = next
      if (presentationRef.current) setSnapshot(next)
    })
    const disposePresentation = window.codexStatus.onIslandPresentation((next) =>
      presentationHandlerRef.current(next)
    )
    return () => {
      active = false
      disposeIsland()
      disposePresentation()
      stopReminder('unmount')
      diagnostic.trace('window', { reason: 'unmount' })
      diagnostic.buffer.flush()
      window.clearTimeout(exitTimer.current)
      window.clearTimeout(holdTimer.current)
      diagnostic.buffer.dispose()
    }
    // 诊断包装只读稳定 ref，不能因包装函数重建而重新订阅业务事件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (rendererReady) void window.codexStatus.notifyIslandReady()
  }, [rendererReady])

  useEffect(() => {
    if (mode === 'hidden') return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [mode])

  useEffect(() => {
    const candidate = findAlertCandidate(snapshot, seenEvents.current)
    if (!candidate) return
    seenEvents.current.add(alertEventId(candidate))
    setAlertTask(candidate)
    diagnostic.request('alert', 'candidate-unless-expanded')
    setModeState((current) => (current === 'expanded' ? current : 'alert'))
    startReminderRef.current()
  }, [snapshot, diagnostic])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || modeRef.current === 'hidden') return
      if (modeRef.current === 'alert') finishAlertRef.current('escape')
      else setMode('compact', 'escape')
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // setMode 包装只增加诊断，保留原有键盘监听生命周期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent): void => {
      if (!stageRef.current?.contains(event.target as Node)) return
      focused.current = (event.target as HTMLElement).matches(':focus-visible')
      diagnostic.trace('focus', { reason: 'focus-in' })
      pauseReminderRef.current()
    }
    const handleFocusOut = (event: FocusEvent): void => {
      if (stageRef.current?.contains(event.relatedTarget as Node | null)) return
      focused.current = false
      diagnostic.trace('focus', { reason: 'focus-out' })
      resumeReminderRef.current()
    }
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [diagnostic])

  useEffect(() => {
    const element = alertRef.current
    if (!element || mode !== 'alert' || !presentation.visible) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const glyph = element.querySelector('.status-glyph')
    element.animate(
      [
        { opacity: 0, filter: 'blur(4px)', transform: 'translateY(7px) scale(.97)' },
        { opacity: 1, filter: 'blur(0)', transform: 'translateY(0) scale(1)' }
      ],
      { duration: 280, delay: 90, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.2,1)' }
    )
    glyph?.animate(
      [
        { opacity: 0, transform: 'scale(.65)' },
        { opacity: 1, transform: 'scale(1.06)', offset: 0.65 },
        { opacity: 1, transform: 'scale(1)' }
      ],
      { duration: 500, delay: 140, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.2,1)' }
    )
  }, [alertEvent, mode, presentation.visible])

  const activeTasks = useMemo(
    () => snapshot.tasks.filter((task) => getDisplayStatus(task) !== 'stopped'),
    [snapshot.tasks]
  )
  const pendingTasks = activeTasks.filter((task) =>
    ['waiting-approval', 'waiting-input'].includes(getDisplayStatus(task))
  )
  const runningCount = activeTasks.filter((task) => getDisplayStatus(task) === 'running').length
  const completedCount = activeTasks.filter((task) => getDisplayStatus(task) === 'completed').length
  const failedCount = activeTasks.filter((task) => getDisplayStatus(task) === 'failed').length
  const leadingTask = activeTasks[0]
  const compactTask = leadingTask ?? alertTask
  const compactStatus = compactTask ? getDisplayStatus(compactTask) : undefined
  const satelliteStatus = getSatelliteStatus(pendingTasks)
  const expandedHeight = activeTasks.length <= 1 ? 200 : activeTasks.length === 2 ? 281 : 362

  useEffect(() => {
    if (!presentation.visible) return
    let interactive = false
    const effect = ++diagnostic.counters.current.effect
    diagnostic.trace('effect', {
      reason: 'setup',
      effect,
      expandedHeight,
      satellite: satelliteStatus !== undefined
    })
    // rAF 节流:forward 转发的鼠标移动每秒可达数百次,命中检测每帧至多一次
    let pendingEvent: MouseEvent | undefined
    let frameId: number | undefined
    const updateInteractive = (next: boolean, reason: string): void => {
      if (next === interactive) return
      interactive = next
      setIslandInteractive(next, reason, effect)
    }
    const cancelPendingHitTest = (): void => {
      if (frameId !== undefined) cancelAnimationFrame(frameId)
      frameId = undefined
      pendingEvent = undefined
    }
    const runHitTest = (): void => {
      frameId = undefined
      const event = pendingEvent
      pendingEvent = undefined
      if (!event) return
      diagnostic.samplePoint(event)
      updateInteractive(
        isPointInIsland(
          event.clientX,
          event.clientY,
          mode,
          expandedHeight,
          satelliteStatus !== undefined
        ),
        'hit-test'
      )
    }
    const handlePointerMove = (event: MouseEvent): void => {
      pendingEvent = event
      if (frameId === undefined) frameId = requestAnimationFrame(runHitTest)
    }
    const handleMouseLeave = (): void => {
      diagnostic.trace('pointer', { reason: 'document-leave', effect })
      cancelPendingHitTest()
      updateInteractive(false, 'document-leave')
    }
    cancelInteractiveFrameRef.current = cancelPendingHitTest
    // pointermove/mousemove 在 Chromium 同源派发,双注册只会双倍命中检测,留 pointermove
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      diagnostic.trace('effect', {
        reason: 'cleanup',
        effect,
        interactive,
        expandedHeight,
        satellite: satelliteStatus !== undefined
      })
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('mouseleave', handleMouseLeave)
      cancelPendingHitTest()
      if (cancelInteractiveFrameRef.current === cancelPendingHitTest) {
        cancelInteractiveFrameRef.current = () => undefined
      }
      updateInteractive(false, 'effect-cleanup')
    }
    // 包装函数只访问稳定诊断对象；加入依赖会让日志触发额外穿透切换。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedHeight, mode, presentation.visible, satelliteStatus])

  function handlePresentation(next: IslandPresentation): void {
    diagnostic.trace('presentation', {
      reason: 'received',
      revision: next.revision,
      visible: next.visible,
      cancelled: diagnostic.counters.current.exit !== 0
    })
    diagnostic.counters.current.exit = 0
    window.clearTimeout(exitTimer.current)
    presentationRef.current = next.visible
    setPresentation(next)
    if (next.visible) {
      setSnapshot(latestSnapshot.current)
      stopReminder('presentation-show')
      setMode('hidden', 'presentation-show')
      requestAnimationFrame(() => {
        diagnostic.request('compact', 'presentation-frame-unless-active')
        setModeState((current) =>
          current === 'alert' || current === 'expanded' ? current : 'compact'
        )
        resumeReminder()
      })
      return
    }
    stopReminder('presentation-hide')
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : EXIT_DURATION_MS
    diagnostic.counters.current.exit = next.revision
    diagnostic.trace('presentation', { reason: 'exit-scheduled', revision: next.revision, delay })
    exitTimer.current = window.setTimeout(() => {
      diagnostic.counters.current.exit = 0
      diagnostic.trace('presentation', { reason: 'exit-fired', revision: next.revision })
      setMode('hidden', 'presentation-exit')
      diagnostic.trace('hidden-ack', { reason: 'sent', revision: next.revision })
      diagnostic.buffer.flush()
      void window.codexStatus.notifyIslandHidden(next.revision)
    }, delay)
  }

  function startReminder(): void {
    stopReminder('replace')
    const timer = ++diagnostic.counters.current.timer
    diagnostic.trace('reminder', { reason: 'create', timer })
    reminder.current = new PausableReminder(ISLAND_ALERT_DURATION_MS, () => {
      diagnostic.trace('reminder', { reason: 'fire', timer })
      finishAlert('reminder-fired')
    })
    if (!isHolding()) {
      diagnostic.trace('reminder', { reason: 'start-call', timer })
      reminder.current.start()
    }
  }

  function stopReminder(reason: string): void {
    if (reminder.current)
      diagnostic.trace('reminder', {
        reason: `stop-${reason}`,
        timer: diagnostic.counters.current.timer
      })
    reminder.current?.stop()
  }

  function resumeReminder(): void {
    if (modeRef.current !== 'alert' || isHolding()) return
    diagnostic.trace('reminder', {
      reason: 'resume-call',
      timer: diagnostic.counters.current.timer
    })
    reminder.current?.start()
  }

  function pauseReminder(): void {
    if (modeRef.current !== 'alert') return
    diagnostic.trace('reminder', { reason: 'pause-call', timer: diagnostic.counters.current.timer })
    reminder.current?.pause()
  }

  function finishAlert(reason: string): void {
    setMode('compact', reason)
  }

  function isHolding(): boolean {
    return hovering.current || focused.current
  }

  function handlePointerEnter(event: React.PointerEvent): void {
    hovering.current = true
    diagnostic.pointer('pointer-enter', event)
    setIslandInteractive(true, 'pointer-enter')
    pauseReminder()
  }

  function handlePointerLeave(event: React.PointerEvent): void {
    hovering.current = false
    diagnostic.pointer('pointer-leave', event)
    cancelInteractiveFrameRef.current()
    setIslandInteractive(false, 'pointer-leave')
    if (modeRef.current === 'alert') resumeReminder()
    if (modeRef.current === 'expanded' && !focused.current) setMode('compact', 'pointer-leave')
  }

  function setIslandInteractive(interactive: boolean, reason: string, effect?: number): void {
    const request = diagnostic.trace('interactive', {
      interactive,
      reason,
      ...(effect && { effect })
    })
    const correlation =
      request === undefined ? undefined : { instance: diagnostic.buffer.instance!, request }
    void window.codexStatus.setIslandInteractive(interactive, correlation)
  }

  function openTask(task: IslandTask): void {
    stopReminder('open-task')
    setNavigationError('')
    void window.codexStatus.openIslandTask(task.threadId).then((confirmed) => {
      if (!confirmed) {
        setNavigationError('无法定位任务，已打开 Codex')
        return
      }
      if (task.phase === 'failed') return
      if (task.phase === 'completed') {
        setMode('compact', 'open-completed')
        return
      }
      setMode('compact', 'open-task')
    })
  }

  function dismissTask(task: IslandTask): void {
    void window.codexStatus.dismissIslandTask(task.threadId).then((dismissed) => {
      if (!dismissed) return
      setAlertTask(undefined)
      setMode('compact', 'dismiss-task')
    })
  }

  function dismissIsland(): void {
    if (mode === 'alert') finishAlert('collapse-button')
    else setMode('compact', 'collapse-button')
  }

  function handleCompactPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    diagnostic.pointer('compact-down', event)
    if (event.button !== 0) return
    holdTimer.current = window.setTimeout(() => setMode('expanded', 'hold-fired'), HOLD_DURATION_MS)
  }

  function clearHold(event: React.PointerEvent<HTMLButtonElement>): void {
    diagnostic.pointer(`compact-${event.type}`, event)
    window.clearTimeout(holdTimer.current)
  }

  startReminderRef.current = startReminder
  finishAlertRef.current = finishAlert
  pauseReminderRef.current = pauseReminder
  resumeReminderRef.current = resumeReminder
  presentationHandlerRef.current = handlePresentation

  const displayMode = presentation.visible ? mode : 'hidden'
  const signalStatus = compactStatus ?? (alertTask ? getDisplayStatus(alertTask) : 'running')

  return (
    <main className="island-window">
      <div
        className="island-stage"
        data-multiple={satelliteStatus ? 'true' : 'false'}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        ref={stageRef}
      >
        <section
          aria-label="Codex 任务活动"
          className="island"
          data-mode={displayMode}
          data-status={compactStatus}
          style={
            {
              '--expanded-height': `${expandedHeight}px`,
              '--signal': statusColor(signalStatus),
              '--exit': `${EXIT_DURATION_MS}ms`
            } as CSSProperties
          }
        >
          <button
            aria-expanded={mode === 'expanded'}
            aria-hidden={mode !== 'compact'}
            className="compact layer"
            inert={mode !== 'compact'}
            onClick={(event) => {
              diagnostic.pointer('compact-click', event)
              setMode('expanded', 'compact-click')
            }}
            onPointerCancel={clearHold}
            onPointerDown={handleCompactPointerDown}
            onPointerLeave={clearHold}
            onPointerUp={clearHold}
            type="button"
          >
            <span className="compact-leading">
              <ChatGptIcon />
              {compactLabel(
                pendingTasks.length,
                runningCount,
                completedCount,
                failedCount,
                activeTasks.length
              )}
            </span>
            <span className="compact-trailing">
              {compactStatus ? <StatusIcon status={compactStatus} /> : null}
              {compactTask ? formatTaskDuration(compactTask, now) : '--:--'}
            </span>
          </button>

          <div
            aria-hidden={mode !== 'alert'}
            className="alert layer"
            inert={mode !== 'alert'}
            ref={alertRef}
          >
            {alertTask ? (
              <>
                <div className="activity-header">
                  <span className="app-label">
                    <ChatGptIcon />
                    Codex
                  </span>
                  <span>{STATUS_COPY[getDisplayStatus(alertTask)]}</span>
                </div>
                <div className="alert-main">
                  <span className="status-glyph">
                    <StatusIcon status={getDisplayStatus(alertTask)} />
                  </span>
                  <div className="alert-copy">
                    <h2>{alertTask.title}</h2>
                    <p>{alertTask.requests[0]?.summary ?? alertTask.project}</p>
                  </div>
                </div>
                <div className="alert-footer">
                  <span>{alertTask.project}</span>
                  <div>
                    {['failed', 'completed'].includes(alertTask.phase) ? (
                      <button onClick={() => dismissTask(alertTask)} type="button">
                        关闭
                      </button>
                    ) : null}
                    <button onClick={() => openTask(alertTask)} type="button">
                      查看任务 <ArrowIcon />
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div
            aria-hidden={mode !== 'expanded'}
            className="expanded layer"
            inert={mode !== 'expanded'}
          >
            <div className="activity-header">
              <span className="app-label">
                <ChatGptIcon />
                Codex
              </span>
              <button
                aria-label="收起任务列表"
                className="collapse"
                onClick={dismissIsland}
                type="button"
              >
                <CollapseIcon />
              </button>
            </div>
            <div className="overview">
              <h2>任务活动</h2>
              <span>
                {pendingTasks.length} 待处理 · {runningCount} 执行中
              </span>
            </div>
            <div className="task-list" data-scrollable={activeTasks.length > 3}>
              {activeTasks.map((task) => {
                const status = getDisplayStatus(task)
                return (
                  <button
                    className="task"
                    data-status={status}
                    key={`${task.hostId}:${task.threadId}`}
                    onClick={() => openTask(task)}
                    style={{ '--signal': statusColor(status) } as CSSProperties}
                    type="button"
                  >
                    <StatusIcon status={status} />
                    <span className="task-body">
                      <span className="task-title">{task.title}</span>
                      <span className="task-meta">{task.project}</span>
                      {task.requests[0]?.summary ? (
                        <span className="task-summary">{task.requests[0].summary}</span>
                      ) : null}
                    </span>
                    <span className="task-aside">
                      {STATUS_COPY[status]}
                      <time>{formatTaskDuration(task, now)}</time>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </section>
        {satelliteStatus ? (
          <button
            aria-label={`${satelliteStatus === 'waiting-approval' ? '审批' : '回复'}任务，展开查看`}
            aria-hidden={mode !== 'compact'}
            className="satellite"
            data-status={satelliteStatus}
            inert={mode !== 'compact'}
            onClick={(event) => {
              diagnostic.pointer('satellite-click', event)
              setMode('expanded', 'satellite-click')
            }}
            type="button"
          >
            <StatusIcon status={satelliteStatus} />
          </button>
        ) : null}
      </div>
      {navigationError ? (
        <p className="island-navigation-error" role="status">
          {navigationError}
        </p>
      ) : null}
    </main>
  )
}

function findAlertCandidate(
  snapshot: IslandSnapshot,
  seenEvents: Set<string>
): IslandTask | undefined {
  return snapshot.tasks.find((task) => {
    const status = getDisplayStatus(task)
    const eventId = alertEventId(task)
    return (
      ALERT_STATUSES.includes(status) &&
      !seenEvents.has(eventId) &&
      !snapshot.viewedEventIds.includes(eventId) &&
      snapshot.visibleThreadId !== task.threadId
    )
  })
}

function isPointInIsland(
  x: number,
  y: number,
  mode: IslandMode,
  expandedHeight: number,
  hasSatellite: boolean
): boolean {
  return islandHitRects(mode, expandedHeight, hasSatellite).some(
    (rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
  )
}

function islandHitRects(
  mode: IslandMode,
  expandedHeight: number,
  hasSatellite: boolean
): { x: number; y: number; width: number; height: number }[] {
  if (mode === 'hidden') return []
  if (mode === 'alert') return [{ x: 34, y: 0, width: 396, height: 198 }]
  if (mode === 'expanded') return [{ x: 26, y: 0, width: 412, height: expandedHeight }]
  if (!hasSatellite) return [{ x: 108, y: 0, width: 248, height: 48 }]
  return [
    { x: 93, y: 0, width: 220, height: 48 },
    { x: 313, y: 0, width: 10, height: 48 },
    { x: 323, y: 0, width: 48, height: 48 }
  ]
}

function alertEventId(task: IslandTask): string {
  return task.requests[0]?.id ?? task.latestEventId
}

function getSatelliteStatus(
  tasks: readonly IslandTask[]
): 'waiting-approval' | 'waiting-input' | undefined {
  if (tasks.some((task) => getDisplayStatus(task) === 'waiting-approval')) return 'waiting-approval'
  if (tasks.some((task) => getDisplayStatus(task) === 'waiting-input')) return 'waiting-input'
  return undefined
}

function compactLabel(
  pendingCount: number,
  runningCount: number,
  completedCount: number,
  failedCount: number,
  total: number
): string {
  if (pendingCount > 0) return `${pendingCount} 待处理`
  if (failedCount > 0) return `${failedCount} 失败`
  if (runningCount > 0) return `${runningCount} 执行中`
  if (completedCount > 0) return `${completedCount} 已完成`
  return total > 0 ? `${total} 任务` : ''
}

function statusColor(status: IslandDisplayStatus): string {
  if (status === 'waiting-approval') return 'var(--attention)'
  if (status === 'waiting-input') return 'var(--reply)'
  if (status === 'failed') return 'var(--danger)'
  if (status === 'stopped') return 'var(--neutral)'
  return 'var(--running)'
}

function formatTaskDuration(task: IslandTask, now: number): string {
  if (task.startedAt === undefined) return '--:--'
  const endAt = task.phase === 'running' ? now : task.updatedAt
  const seconds = Math.max(0, Math.floor((endAt - task.startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function ChatGptIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="icon brand-icon" viewBox="0 0 41 41">
      <path d="M37.5324 16.8707C37.9808 15.5241 38.1363 14.0974 37.9886 12.6859C37.8409 11.2744 37.3934 9.91076 36.676 8.68622C35.6126 6.83404 33.9882 5.3676 32.0373 4.4985C30.0864 3.62941 27.9098 3.40259 25.8215 3.85078C24.8796 2.7893 23.7219 1.94125 22.4257 1.36341C21.1295 0.785575 19.7249 0.491269 18.3058 0.500197C16.1708 0.495044 14.0893 1.16803 12.3614 2.42214C10.6335 3.67624 9.34853 5.44666 8.6917 7.47815C7.30085 7.76286 5.98686 8.3414 4.8377 9.17505C3.68854 10.0087 2.73073 11.0782 2.02839 12.312C0.956464 14.1591 0.498905 16.2988 0.721698 18.4228C0.944492 20.5467 1.83612 22.5449 3.268 24.1293C2.81966 25.4759 2.66413 26.9026 2.81182 28.3141C2.95951 29.7256 3.40701 31.0892 4.12437 32.3138C5.18791 34.1659 6.8123 35.6322 8.76321 36.5013C10.7141 37.3704 12.8907 37.5973 14.9789 37.1492C15.9208 38.2107 17.0786 39.0587 18.3747 39.6366C19.6709 40.2144 21.0755 40.5087 22.4946 40.4998C24.6307 40.5054 26.7133 39.8321 28.4418 38.5772C30.1704 37.3223 31.4556 35.5506 32.1119 33.5179C33.5027 33.2332 34.8167 32.6547 35.9659 31.821C37.115 30.9874 38.0728 29.9178 38.7752 28.684C39.8458 26.8371 40.3023 24.6979 40.0789 22.5748C39.8556 20.4517 38.9639 18.4544 37.5324 16.8707ZM22.4978 37.8849C20.7443 37.8874 19.0459 37.2733 17.6994 36.1501C17.7601 36.117 17.8666 36.0586 17.936 36.0161L25.9004 31.4156C26.1003 31.3019 26.2663 31.137 26.3813 30.9378C26.4964 30.7386 26.5563 30.5124 26.5549 30.2825V19.0542L29.9213 20.998C29.9389 21.0068 29.9541 21.0198 29.9656 21.0359C29.977 21.052 29.9842 21.0707 29.9867 21.0902V30.3889C29.9842 32.375 29.1946 34.2791 27.7909 35.6841C26.3872 37.0892 24.4838 37.8806 22.4978 37.8849ZM6.39227 31.0064C5.51397 29.4888 5.19742 27.7107 5.49804 25.9832C5.55718 26.0187 5.66048 26.0818 5.73461 26.1244L13.699 30.7248C13.8975 30.8408 14.1233 30.902 14.3532 30.902C14.583 30.902 14.8088 30.8408 15.0073 30.7248L24.731 25.1103V28.9979C24.7321 29.0177 24.7283 29.0376 24.7199 29.0556C24.7115 29.0736 24.6988 29.0893 24.6829 29.1012L16.6317 33.7497C14.9096 34.7416 12.8643 35.0097 10.9447 34.4954C9.02506 33.9811 7.38785 32.7263 6.39227 31.0064ZM4.29707 13.6194C5.17156 12.0998 6.55279 10.9364 8.19885 10.3327C8.19885 10.4013 8.19491 10.5228 8.19491 10.6071V19.808C8.19351 20.0378 8.25334 20.2638 8.36823 20.4629C8.48312 20.6619 8.64893 20.8267 8.84863 20.9404L18.5723 26.5542L15.206 28.4979C15.1894 28.5089 15.1703 28.5155 15.1505 28.5173C15.1307 28.5191 15.1107 28.516 15.0924 28.5082L7.04046 23.8557C5.32135 22.8601 4.06716 21.2235 3.55289 19.3046C3.03862 17.3858 3.30624 15.3413 4.29707 13.6194ZM31.955 20.0556L22.2312 14.4411L25.5976 12.4981C25.6142 12.4872 25.6333 12.4805 25.6531 12.4787C25.6729 12.4769 25.6928 12.4801 25.7111 12.4879L33.7631 17.1364C34.9967 17.849 36.0017 18.8982 36.6606 20.1613C37.3194 21.4244 37.6047 22.849 37.4832 24.2684C37.3617 25.6878 36.8382 27.0432 35.9743 28.1759C35.1103 29.3086 33.9415 30.1717 32.6047 30.6641C32.6047 30.5947 32.6047 30.4733 32.6047 30.3889V21.188C32.6066 20.9586 32.5474 20.7328 32.4332 20.5338C32.319 20.3348 32.154 20.1698 31.955 20.0556ZM35.3055 15.0128C35.2464 14.9765 35.1431 14.9142 35.069 14.8717L27.1045 10.2712C26.906 10.1554 26.6803 10.0943 26.4504 10.0943C26.2206 10.0943 25.9948 10.1554 25.7963 10.2712L16.0726 15.8858V11.9982C16.0715 11.9783 16.0753 11.9585 16.0837 11.9405C16.0921 11.9225 16.1048 11.9068 16.1207 11.8949L24.1719 7.25025C25.4053 6.53903 26.8158 6.19376 28.2383 6.25482C29.6608 6.31589 31.0364 6.78077 32.2044 7.59508C33.3723 8.40939 34.2842 9.53945 34.8334 10.8531C35.3826 12.1667 35.5464 13.6095 35.3055 15.0128ZM14.2424 21.9419L10.8752 19.9981C10.8576 19.9893 10.8423 19.9763 10.8309 19.9602C10.8195 19.9441 10.8122 19.9254 10.8098 19.9058V10.6071C10.8107 9.18295 11.2173 7.78848 11.9819 6.58696C12.7466 5.38544 13.8377 4.42659 15.1275 3.82264C16.4173 3.21869 17.8524 2.99464 19.2649 3.1767C20.6775 3.35876 22.0089 3.93941 23.1034 4.85067C23.0427 4.88379 22.937 4.94215 22.8668 4.98473L14.9024 9.58517C14.7025 9.69878 14.5366 9.86356 14.4215 10.0626C14.3065 10.2616 14.2466 10.4877 14.2479 10.7175L14.2424 21.9419ZM16.071 17.9991L20.4018 15.4978L24.7325 17.9975V22.9985L20.4018 25.4983L16.071 22.9985V17.9991Z" />
    </svg>
  )
}

function ArrowIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 256 256">
      <path d="M200,64V168a8,8,0,0,1-13.66,5.66L140,127.31,69.66,197.66a8,8,0,0,1-11.32-11.32L128.69,116,82.34,69.66A8,8,0,0,1,88,56H192A8,8,0,0,1,200,64Z" />
    </svg>
  )
}

function CollapseIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 256 256">
      <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,48,88H208a8,8,0,0,1,5.66,13.66Z" />
    </svg>
  )
}

function StatusIcon({ status }: { status: IslandDisplayStatus }): React.JSX.Element {
  if (status === 'running')
    return (
      <span aria-hidden="true" className="waveform" data-status="running">
        <i />
        <i />
        <i />
        <i />
      </span>
    )
  const icon =
    status === 'waiting-approval'
      ? 'approval'
      : status === 'waiting-input'
        ? 'question'
        : status === 'completed'
          ? 'complete'
          : status === 'failed'
            ? 'failure'
            : 'stopped'
  return (
    <svg
      aria-hidden="true"
      className={`icon status-icon status-icon--${status}`}
      viewBox="0 0 256 256"
    >
      {STATUS_ICON_PATHS[icon]}
    </svg>
  )
}

const STATUS_ICON_PATHS = {
  approval: (
    <path d="M216,104v48a88,88,0,0,1-176,0V64a16,16,0,0,1,32,0v56a8,8,0,0,0,16,0V32a16,16,0,0,1,32,0v80a8,8,0,0,0,16,0V48a16,16,0,0,1,32,0v80.67A48.08,48.08,0,0,0,128,176a8,8,0,0,0,16,0,32,32,0,0,1,32-32,8,8,0,0,0,8-8V104a16,16,0,0,1,32,0Z" />
  ),
  question: (
    <path d="M128,24A104,104,0,0,0,36.18,176.88L24.83,210.93a16,16,0,0,0,20.24,20.24l34.05-11.35A104,104,0,1,0,128,24ZM84,140a12,12,0,1,1,12-12A12,12,0,0,1,84,140Zm44,0a12,12,0,1,1,12-12A12,12,0,0,1,128,140Zm44,0a12,12,0,1,1,12-12A12,12,0,0,1,172,140Z" />
  ),
  complete: (
    <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z" />
  ),
  failure: (
    <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm-8,56a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm8,104a12,12,0,1,1,12-12A12,12,0,0,1,128,184Z" />
  ),
  stopped: (
    <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm32,132a4,4,0,0,1-4,4H100a4,4,0,0,1-4-4V100a4,4,0,0,1,4-4h56a4,4,0,0,1,4,4Z" />
  )
} as const
