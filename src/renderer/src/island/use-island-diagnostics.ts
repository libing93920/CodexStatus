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
  interactive: { current: boolean }
  pendingHitTest: { current: boolean }
  point: { current: { x: number; y: number; timeStamp: number; valid: boolean } }
  expandedHeight: number
  satellite: boolean
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
  pointer: (
    reason: string,
    event: React.MouseEvent | React.PointerEvent | MouseEvent,
    fields?: IslandDiagFields
  ) => void
  request: (to: Mode, reason: string, fields?: IslandDiagFields) => void
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
  const previousDisplayMode = useRef<Mode>('hidden')
  const expansion = useRef(0)
  const expandedStartedAt = useRef<number | undefined>(undefined)

  const trace = useCallback(
    (event: IslandDiagEventName, fields: IslandDiagFields = {}): number | undefined => {
      if (!buffer.enabled) return undefined
      const current = contextRef.current
      const point = current.point.current
      const now = performance.now()
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
        interactive: current.interactive.current,
        pendingHitTest: current.pendingHitTest.current,
        expandedHeight: current.expandedHeight,
        satellite: current.satellite,
        pointValid: point.valid,
        ...(point.valid && {
          x: point.x,
          y: point.y,
          pointAge: Math.max(0, now - point.timeStamp)
        }),
        ...(expansion.current > 0 && { expansion: expansion.current }),
        ...(expandedStartedAt.current !== undefined && {
          expandedAge: Math.max(0, now - expandedStartedAt.current)
        }),
        ...fields
      })
    },
    [buffer]
  )

  const pointer = useCallback(
    (
      reason: string,
      event: React.MouseEvent | React.PointerEvent | MouseEvent,
      fields: IslandDiagFields = {}
    ): void => {
      if (!buffer.enabled) return
      if (reason === 'compact-down') counters.current.interaction++
      trace('pointer', {
        reason,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
        pointAge: Math.max(0, performance.now() - event.timeStamp),
        ...fields
      })
    },
    [buffer, trace]
  )

  const request = useCallback(
    (to: Mode, reason: string, fields: IslandDiagFields = {}): void => {
      if (!buffer.enabled) return
      trace('mode-request', { to, reason, request: ++counters.current.request, ...fields })
    },
    [buffer, trace]
  )

  useLayoutEffect(() => {
    const displayMode = context.presentation.visible ? context.mode : 'hidden'
    if (
      displayMode === 'expanded' &&
      previousDisplayMode.current !== 'expanded' &&
      buffer.enabled
    ) {
      expansion.current++
      expandedStartedAt.current = performance.now()
    }
    if (context.mode !== previousMode.current) {
      trace('mode-commit', {
        from: previousMode.current,
        to: context.mode,
        firstRequest: counters.current.committed + 1,
        lastRequest: counters.current.request,
        modeRef: context.mode
      })
      counters.current.committed = counters.current.request
    }
    if (previousDisplayMode.current === 'expanded' && displayMode !== 'expanded') {
      trace('effect', { reason: 'expanded-exit', from: 'expanded', to: displayMode })
      expandedStartedAt.current = undefined
    }
    previousMode.current = context.mode
    previousDisplayMode.current = displayMode
    if (context.mode === 'hidden') buffer.flush()
  }, [context.mode, context.presentation.visible, buffer, trace])

  useEffect(() => {
    const flush = (): void => buffer.flush()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
    }
  }, [buffer])

  return useMemo(
    () => ({ buffer, trace, pointer, request, counters }),
    [buffer, trace, pointer, request]
  )
}
