import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  createEmptyIslandSnapshot,
  getDisplayStatus,
  ISLAND_ALERT_DURATION_MS,
  type IslandDisplayStatus,
  type IslandSnapshot,
  type IslandTask
} from '../../../shared/island'
import './island.css'

type IslandMode = 'compact' | 'alert' | 'expanded'

const STATUS_COPY: Record<IslandDisplayStatus, string> = {
  'waiting-approval': '需要审批',
  'waiting-input': '需要回复',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止'
}

export default function Island(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<IslandSnapshot>(createEmptyIslandSnapshot)
  const [mode, setMode] = useState<IslandMode>('compact')
  const [alertTask, setAlertTask] = useState<IslandTask>()
  const [navigationError, setNavigationError] = useState('')
  const [now, setNow] = useState(Date.now())
  const seenEvents = useRef(new Set<string>())
  const timer = useRef<number | undefined>(undefined)
  const remainingMs = useRef(0)
  const deadline = useRef(0)
  const hovering = useRef(false)

  useEffect(() => {
    let active = true
    void window.codexStatus.bootstrap().then((payload) => {
      if (!active) return
      setSnapshot(payload.island)
      void window.codexStatus.notifyIslandReady()
    })
    const disposeIsland = window.codexStatus.onIslandUpdated(setSnapshot)
    return () => {
      active = false
      disposeIsland()
      window.clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    if (snapshot.tasks.length === 0) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [snapshot.tasks.length])

  useEffect(() => {
    const candidate = snapshot.tasks.find((task) => {
      const status = getDisplayStatus(task)
      const eventId = task.requests[0]?.id ?? task.latestEventId
      return (
        !seenEvents.current.has(eventId) &&
        !snapshot.viewedEventIds.includes(eventId) &&
        snapshot.visibleThreadId !== task.threadId &&
        ['waiting-approval', 'waiting-input', 'failed', 'completed'].includes(status)
      )
    })
    if (!candidate) return
    seenEvents.current.add(candidate.requests[0]?.id ?? candidate.latestEventId)
    setAlertTask(candidate)
    setMode('alert')
    remainingMs.current = ISLAND_ALERT_DURATION_MS
    resumeAlertTimer()
  }, [snapshot])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMode('compact')
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const activeTasks = useMemo(
    () => snapshot.tasks.filter((task) => getDisplayStatus(task) !== 'stopped'),
    [snapshot.tasks]
  )
  const pendingCount = activeTasks.filter((task) =>
    ['waiting-approval', 'waiting-input'].includes(getDisplayStatus(task))
  ).length
  const runningCount = activeTasks.filter((task) => getDisplayStatus(task) === 'running').length
  const leadingTask = activeTasks[0]
  const expandedHeight = 100 + Math.min(activeTasks.length, 3) * 70

  function resumeAlertTimer(): void {
    window.clearTimeout(timer.current)
    if (hovering.current || remainingMs.current <= 0) return
    deadline.current = performance.now() + remainingMs.current
    timer.current = window.setTimeout(() => {
      remainingMs.current = 0
      setMode('compact')
    }, remainingMs.current)
  }

  function pauseAlertTimer(): void {
    if (mode !== 'alert') return
    window.clearTimeout(timer.current)
    remainingMs.current = Math.max(0, deadline.current - performance.now())
  }

  function handlePointerEnter(): void {
    hovering.current = true
    void window.codexStatus.setIslandInteractive(true)
    pauseAlertTimer()
  }

  function handlePointerLeave(): void {
    hovering.current = false
    void window.codexStatus.setIslandInteractive(false)
    if (mode === 'alert' && remainingMs.current > 0) resumeAlertTimer()
    if (mode === 'expanded') setMode('compact')
  }

  async function openTask(task: IslandTask): Promise<void> {
    setNavigationError('')
    const confirmed = await window.codexStatus.openIslandTask(task.threadId)
    if (!confirmed) setNavigationError('无法定位任务，已打开 Codex')
  }

  async function dismissTask(task: IslandTask): Promise<void> {
    if (await window.codexStatus.dismissIslandTask(task.threadId)) {
      setAlertTask(undefined)
      setMode('compact')
    }
  }

  if (!leadingTask) return <div className="island-window" />

  return (
    <main className="island-window">
      <section
        aria-label="Codex 任务活动"
        className="dynamic-island"
        data-mode={mode}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        style={{ '--expanded-height': `${expandedHeight}px` } as CSSProperties}
      >
        <button
          aria-expanded={mode === 'expanded'}
          className="island-compact island-layer"
          inert={mode !== 'compact'}
          onClick={() => setMode('expanded')}
          type="button"
        >
          <span className="island-leading">
            <CodeIcon />
            {pendingCount > 0 ? `${pendingCount} 待处理` : `${runningCount || 1} 执行中`}
          </span>
          <span className="island-trailing">
            <Spinner />
            {activeTasks.length > 1
              ? `+${activeTasks.length - 1}`
              : formatTaskDuration(leadingTask, now)}
          </span>
        </button>

        {pendingCount > 0 && mode === 'compact' ? (
          <button
            aria-label={`${pendingCount} 个任务待处理`}
            className="island-satellite"
            onClick={() => setMode('expanded')}
            type="button"
          >
            <StatusIcon status="waiting-approval" />
          </button>
        ) : null}

        <div
          aria-hidden={mode !== 'alert'}
          className="island-alert island-layer"
          inert={mode !== 'alert'}
        >
          {alertTask ? (
            <>
              <header>
                <span>
                  <CodeIcon />
                  Codex
                </span>
                <em>{STATUS_COPY[getDisplayStatus(alertTask)]}</em>
              </header>
              <div className="island-alert__main">
                <div>
                  <h2>{alertTask.title}</h2>
                  <p>{alertTask.requests[0]?.summary ?? alertTask.project}</p>
                </div>
                <StatusIcon status={getDisplayStatus(alertTask)} />
              </div>
              <footer>
                <span>{alertTask.project}</span>
                <div className="island-alert__actions">
                  {['failed', 'completed'].includes(alertTask.phase) ? (
                    <button onClick={() => void dismissTask(alertTask)} type="button">
                      关闭
                    </button>
                  ) : null}
                  <button onClick={() => void openTask(alertTask)} type="button">
                    查看任务 <ArrowIcon />
                  </button>
                </div>
              </footer>
            </>
          ) : null}
        </div>

        <div
          aria-hidden={mode !== 'expanded'}
          className="island-expanded island-layer"
          inert={mode !== 'expanded'}
        >
          <header>
            <span>
              <CodeIcon />
              Codex
            </span>
            <button onClick={() => setMode('compact')} type="button">
              收起
            </button>
          </header>
          <div className="island-overview">
            <h2>任务活动</h2>
            <span>
              {pendingCount} 待处理 · {runningCount} 执行中
            </span>
          </div>
          <div className="island-tasks" data-scrollable={activeTasks.length > 3}>
            {activeTasks.map((task) => (
              <button
                className="island-task"
                key={`${task.hostId}:${task.threadId}`}
                onClick={() => void openTask(task)}
                type="button"
              >
                <StatusIcon status={getDisplayStatus(task)} />
                <span className="island-task__body">
                  <b>{task.title}</b>
                  <small>{task.project}</small>
                  {task.requests[0]?.summary ? <small>{task.requests[0].summary}</small> : null}
                </span>
                <span className="island-task__aside">
                  {STATUS_COPY[getDisplayStatus(task)]}
                  <time>{formatTaskDuration(task, now)}</time>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
      {navigationError ? (
        <p className="island-navigation-error" role="status">
          {navigationError}
        </p>
      ) : null}
    </main>
  )
}

function formatTaskDuration(task: IslandTask, now: number): string {
  const startedAt = task.startedAt
  if (startedAt === undefined) return '--:--'
  const endAt = task.phase === 'running' ? now : task.updatedAt
  const seconds = Math.max(0, Math.floor((endAt - startedAt) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function CodeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" />
    </svg>
  )
}

function ArrowIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </svg>
  )
}

function Spinner(): React.JSX.Element {
  return <span aria-hidden="true" className="island-spinner" />
}

function StatusIcon({ status }: { status: IslandDisplayStatus }): React.JSX.Element {
  if (status === 'running') return <Spinner />
  const path =
    status === 'completed'
      ? 'M8 12l3 3 5-6'
      : status === 'failed'
        ? 'M9 9l6 6m0-6-6 6'
        : 'M12 8v5m0 3h.01'
  return (
    <svg
      aria-hidden="true"
      className={`island-status island-status--${status}`}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="9" />
      <path d={path} />
    </svg>
  )
}
