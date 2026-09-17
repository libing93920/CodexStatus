import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import {
  createIslandDiagBuffer,
  type IslandDiagBuffer,
  type IslandDiagFields,
  type IslandDiagEventName
} from '../../../shared/island-diagnostics'

type Mode = 'hidden' | 'compact' | 'alert' | 'expanded'
interface Context {
  mode: Mode
  modeRef: { current: Mode }
  presentation: { revision: number; visible: boolean }
  hovering: { current: boolean }
  focused: { current: boolean }
}

interface Counters {
  interaction: number
  request: number
  committed: number
  effect: number
  timer: number
  exit: number
}
interface IslandDiagnostics {
  buffer: IslandDiagBuffer
  trace: (event: IslandDiagEventName, fields?: IslandDiagFields) => number | undefined
  pointer: (reason: string, event: React.MouseEvent | React.PointerEvent) => void
  samplePoint: (event: { clientX: number; clientY: number; timeStamp: number }) => void
  request: (to: Mode, reason: string) => void
  counters: RefObject<Counters>
}

/** 仅维护诊断状态，不同步业务 ref 或介入 React 状态更新。 */
export function useIslandDiagnostics(context: Context): IslandDiagnostics {
  const contextRef = useRef(context)
  useLayoutEffect(() => {
    contextRef.current = context
  }, [context])
  const [buffer] = useState(() =>
    createIslandDiagBuffer((batch) => window.codexStatus.logIslandDiagnostic(batch))
  )
  const counters = useRef({
    interaction: 0,
    request: 0,
    committed: 0,
    effect: 0,
    timer: 0,
    exit: 0
  })
  const previousMode = useRef<Mode>('hidden')
  const point = useRef({ x: 0, y: 0, at: 0, valid: false })

  const trace = useCallback(
    (event: IslandDiagEventName, fields: IslandDiagFields = {}): number | undefined => {
      if (!buffer.enabled) return undefined
      const current = contextRef.current
      return buffer.record(event, {
        mode: current.mode,
        modeRef: current.modeRef.current,
        displayMode: current.presentation.visible ? current.mode : 'hidden',
        revision: current.presentation.revision,
        visible: current.presentation.visible,
        hovering: current.hovering.current,
        focused: current.focused.current,
        documentFocused: document.hasFocus(),
        interaction: counters.current.interaction,
        ...(point.current.valid && {
          x: point.current.x,
          y: point.current.y,
          pointAge: Math.max(0, performance.now() - point.current.at)
        }),
        ...fields
      })
    },
    [buffer]
  )

  const samplePoint = useCallback(
    (event: { clientX: number; clientY: number; timeStamp: number }): void => {
      if (!buffer.enabled) return
      // 复用事件时间，不为每次鼠标移动读时钟、生成日志或访问布局。
      point.current.x = event.clientX
      point.current.y = event.clientY
      point.current.at = event.timeStamp
      point.current.valid = true
    },
    [buffer]
  )

  const pointer = useCallback(
    (reason: string, event: React.MouseEvent | React.PointerEvent): void => {
      if (!buffer.enabled) return
      samplePoint(event)
      if (reason === 'compact-down') counters.current.interaction++
      trace('pointer', { reason, button: event.button })
    },
    [buffer, samplePoint, trace]
  )

  const request = useCallback(
    (to: Mode, reason: string): void => {
      if (!buffer.enabled) return
      trace('mode-request', { to, reason, request: ++counters.current.request })
    },
    [buffer, trace]
  )

  useEffect(() => {
    trace('mode-commit', {
      from: previousMode.current,
      to: context.mode,
      firstRequest: counters.current.committed + 1,
      lastRequest: counters.current.request
    })
    previousMode.current = context.mode
    counters.current.committed = counters.current.request
    if (context.mode === 'hidden') buffer.flush()
  }, [context.mode, buffer, trace])

  useEffect(() => {
    const flush = (): void => buffer.flush()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
    }
  }, [buffer])

  return useMemo(
    () => ({ buffer, trace, pointer, samplePoint, request, counters }),
    [buffer, trace, pointer, samplePoint, request]
  )
}
