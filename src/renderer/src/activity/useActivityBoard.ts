import { useEffect, useState } from 'react'
import type { ActivityBoard } from '../../../shared/activity'
import { currentWeekDates, workDateKey } from '../../../shared/work-time'

const ACTIVITY_BOARD_POLL_MS = 10_000
interface BoardResult {
  date: string
  readAt: number
  board?: ActivityBoard
  error?: string
}

export function useActivityBoard(selectedDate?: string): {
  date: string
  board?: ActivityBoard
  error?: string
  loading: boolean
  now: number
  reload: () => void
} {
  const [result, setResult] = useState<BoardResult>()
  const [openedAt] = useState(() => Date.now())
  const [request, setRequest] = useState(0)
  const now = result?.readAt ?? openedAt
  const today = workDateKey(now)
  const date =
    selectedDate && selectedDate <= today && currentWeekDates(now).includes(selectedDate)
      ? selectedDate
      : today
  useEffect(() => {
    let active = true
    let inFlight = false
    let visible = false
    let visibilityChanged = false
    let latestRequest = 0
    let timer: number | undefined
    async function readBoard(): Promise<void> {
      if (!active || !visible || inFlight) return
      inFlight = true
      const requestId = ++latestRequest
      try {
        const board = await window.codexStatus.getActivityBoard(date)
        if (active && requestId === latestRequest && visible && board.date === date)
          setResult({ date, board, readAt: Date.now() })
      } catch (error) {
        if (active && requestId === latestRequest && visible) reportError(error)
      } finally {
        if (requestId === latestRequest) inFlight = false
      }
    }
    function reportError(error: unknown): void {
      setResult((previous) => ({
        date,
        readAt: Date.now(),
        board: previous?.date === date ? previous.board : undefined,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
    function stopPolling(): void {
      if (timer === undefined) return
      window.clearInterval(timer)
      timer = undefined
    }
    function startPolling(): void {
      if (!active || timer !== undefined || !visible) return
      timer = window.setInterval(() => void readBoard(), ACTIVITY_BOARD_POLL_MS)
    }
    function setVisibility(value: boolean): void {
      if (!active || visible === value) return
      visible = value
      if (!visible) {
        stopPolling()
        latestRequest++
        inFlight = false
        return
      }
      void readBoard()
      startPolling()
    }
    const unsubscribeVisibility = window.codexStatus.onPanelVisibilityChanged((value) => {
      visibilityChanged = true
      setVisibility(value)
    })
    void window.codexStatus
      .getPanelVisibility()
      .then((value) => {
        if (!visibilityChanged) setVisibility(value)
      })
      .catch((error: unknown) => {
        if (active && !visibilityChanged) reportError(error)
      })
    return () => {
      active = false
      unsubscribeVisibility()
      stopPolling()
      latestRequest++
    }
  }, [date, request])
  const current = result?.date === date ? result : undefined
  return {
    date,
    board: current?.board,
    error: current?.error,
    loading: !current,
    now,
    reload: () => setRequest((value) => value + 1)
  }
}
