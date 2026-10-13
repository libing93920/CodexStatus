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
    async function readBoard(): Promise<void> {
      if (inFlight) return
      inFlight = true
      try {
        const board = await window.codexStatus.getActivityBoard(date)
        if (active && board.date === date) setResult({ date, board, readAt: Date.now() })
      } catch (error) {
        if (active)
          setResult((previous) => ({
            date,
            readAt: Date.now(),
            board: previous?.date === date ? previous.board : undefined,
            error: error instanceof Error ? error.message : String(error)
          }))
      } finally {
        inFlight = false
      }
    }
    void readBoard()
    const timer = window.setInterval(() => void readBoard(), ACTIVITY_BOARD_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
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
