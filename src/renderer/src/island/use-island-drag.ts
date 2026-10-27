import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'

const DRAG_THRESHOLD = 5

interface DragSession {
  pointerId: number
  target: HTMLButtonElement
  startX: number
  startY: number
  offset: { x: number; y: number }
  moved: boolean
}

interface IslandDragOptions {
  enabled: boolean
  visible: boolean
  compact: boolean
  onStart: () => void
}

export function useIslandDrag(options: IslandDragOptions): {
  dragging: boolean
  pointerActive: { current: boolean }
  suppressClick: { current: boolean }
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
} {
  const [dragging, setDragging] = useState(false)
  const session = useRef<DragSession | undefined>(undefined)
  const frame = useRef<number | undefined>(undefined)
  const pointerActive = useRef(false)
  const suppressClick = useRef(false)
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  }, [options])

  function move(): Promise<void> {
    const current = session.current
    return current?.moved ? window.codexStatus.moveIslandWindow(current.offset) : Promise.resolve()
  }

  function finish(): void {
    const current = session.current
    if (!current) return
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
    const moved = move()
    session.current = undefined
    pointerActive.current = false
    if (current.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId)
    }
    if (current.moved) {
      void moved.then(() => window.codexStatus.finishIslandWindowDrag()).catch(console.error)
    }
    setDragging(false)
  }

  useEffect(() => {
    if (!options.enabled || !options.visible || !options.compact) finish()
    // 指针会话只在可移动条件消失时收尾，不能因回调身份变化中断拖动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.visible, options.compact])

  useEffect(() => () => finish(), []) // eslint-disable-line react-hooks/exhaustive-deps

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    suppressClick.current = false
    if (!latest.current.enabled || event.button !== 0 || !latest.current.compact) return
    const rect = event.currentTarget.getBoundingClientRect()
    session.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: event.screenX,
      startY: event.screenY,
      offset: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      moved: false
    }
    pointerActive.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const current = session.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved) {
      if (Math.abs(event.screenX - current.startX) < DRAG_THRESHOLD) return
      current.moved = true
      suppressClick.current = true
      setDragging(true)
      latest.current.onStart()
    }
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      void move().catch(console.error)
    })
  }

  return {
    dragging,
    pointerActive,
    suppressClick,
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: finish
  }
}
