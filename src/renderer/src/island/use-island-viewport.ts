import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction
} from 'react'
import { flushSync } from 'react-dom'
import type { IslandLayout, IslandLayoutUpdate, IslandMode } from '../../../shared/island-layout'
import type { IslandViewportRequest } from '../../../shared/island-viewport'
import type { IslandPresentation } from '../../../shared/island'

interface ViewportOptions {
  visible: boolean
  presentationRef: RefObject<IslandPresentation>
  expandedHeight: number
  hasSatellite: boolean
  layoutRef: RefObject<IslandLayout | undefined>
  elementRef: RefObject<HTMLElement | null>
  applyLayout: (update: IslandLayoutUpdate) => void
  onError: (error: unknown) => void
}

interface DisplayState {
  mode: IslandMode
  expandedHeight: number
  hasSatellite: boolean
  cardMode: 'alert' | 'expanded'
}

type ViewportTarget = Omit<DisplayState, 'cardMode'>

/** 原生窗口先扩容，内容再过渡；收起过渡完成后才回收画布。 */
export function useIslandViewport(options: ViewportOptions): {
  mode: IslandMode
  expandedHeight: number
  hasSatellite: boolean
  cardMode: 'alert' | 'expanded'
  rebasing: boolean
  rebasingRef: RefObject<boolean>
  cancel: () => void
  setMode: (next: SetStateAction<IslandMode>) => void
  receiveLayout: (update: IslandLayoutUpdate) => void
} {
  const [display, setDisplay] = useState<DisplayState>({
    mode: 'hidden',
    expandedHeight: options.expandedHeight,
    hasSatellite: false,
    cardMode: 'expanded'
  })
  const [rebasing, setRebasing] = useState(false)
  const rebasingRef = useRef(false)
  const desired = useRef<ViewportTarget>(display)
  const sequence = useRef(0)
  const pending = useRef(false)
  const disposed = useRef(false)
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })

  const commitDisplay = useCallback((target: ViewportTarget): void => {
    setDisplay((previous) => ({
      ...target,
      // 收回时保留卡片内容，随外壳一起淡出，避免先露出空壳。
      cardMode:
        target.mode === 'alert' || target.mode === 'expanded' ? target.mode : previous.cardMode
    }))
  }, [])

  const rebase = useCallback((active: boolean, commit?: () => void): void => {
    rebasingRef.current = active
    flushSync(() => {
      setRebasing(active)
      commit?.()
    })
  }, [])

  const current = useCallback((revision: number): boolean => {
    return (
      !disposed.current &&
      revision === sequence.current &&
      latest.current.presentationRef.current.visible
    )
  }, [])

  const cancel = useCallback((): void => {
    sequence.current++
    pending.current = false
    rebasingRef.current = false
    setRebasing(false)
  }, [])

  const receiveLayout = useCallback(
    (update: IslandLayoutUpdate): void => {
      const previousMode = latest.current.layoutRef.current?.displayMode
      if (previousMode !== undefined && previousMode !== update.layout.displayMode) {
        cancel()
        const hidden: ViewportTarget = { ...desired.current, mode: 'hidden' }
        desired.current = hidden
        rebase(true, () => {
          commitDisplay(hidden)
          latest.current.applyLayout(update)
        })
      } else {
        rebase(true, () => latest.current.applyLayout(update))
      }
      if (pending.current) return
      void nextFrame().then(() => {
        if (!disposed.current && !pending.current) rebase(false)
      })
    },
    [cancel, commitDisplay, rebase]
  )

  const transition = useCallback(
    async (target: ViewportTarget, revision: number): Promise<void> => {
      const layout = latest.current.layoutRef.current
      if (!layout || target.mode === 'hidden') return
      const request: IslandViewportRequest = {
        displayMode: layout.displayMode,
        mode: target.mode,
        expandedHeight: target.expandedHeight,
        hasSatellite: target.hasSatellite,
        revision,
        presentationRevision: latest.current.presentationRef.current.revision,
        phase: 'prepare'
      }
      const prepared = await window.codexStatus.setIslandViewport(request)
      if (!current(revision)) return
      if (!prepared) throw new Error('Island viewport preparation was not accepted')
      receiveLayout(prepared)
      await nextFrame()
      await nextFrame()
      if (!current(revision)) return
      rebase(false, () => commitDisplay(target))
      await nextFrame()
      const animations = latest.current.elementRef.current?.getAnimations() ?? []
      await Promise.allSettled(
        animations.filter(isFiniteAnimation).map((animation) => animation.finished)
      )
      if (!current(revision)) return
      rebase(true)
      const settled = await window.codexStatus.setIslandViewport({ ...request, phase: 'settle' })
      if (!current(revision)) return
      if (!settled) throw new Error('Island viewport settlement was not accepted')
      receiveLayout(settled)
      await nextFrame()
      if (current(revision)) {
        pending.current = false
        rebase(false)
      }
    },
    [commitDisplay, current, rebase, receiveLayout]
  )

  const setMode = useCallback(
    (next: SetStateAction<IslandMode>): void => {
      const mode = typeof next === 'function' ? next(desired.current.mode) : next
      const target = {
        mode,
        expandedHeight: latest.current.expandedHeight,
        hasSatellite: latest.current.hasSatellite
      }
      if (JSON.stringify(target) === JSON.stringify(desired.current) && mode !== 'hidden') return
      desired.current = target
      const revision = ++sequence.current
      if (mode === 'hidden') {
        pending.current = false
        rebasingRef.current = false
        setRebasing(false)
        commitDisplay(target)
        return
      }
      if (!latest.current.presentationRef.current.visible) return
      pending.current = true
      rebasingRef.current = true
      setRebasing(true)
      void transition(target, revision).catch((error) => {
        if (current(revision)) {
          pending.current = false
          rebase(false)
          latest.current.onError(error)
        }
      })
    },
    [commitDisplay, current, rebase, transition]
  )

  useEffect(() => {
    const target = desired.current
    if (!options.visible || target.mode === 'hidden') return
    if (
      target.expandedHeight !== options.expandedHeight ||
      target.hasSatellite !== options.hasSatellite
    ) {
      setMode(target.mode)
    }
  }, [options.expandedHeight, options.hasSatellite, options.visible, setMode])

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      // 作废仍在 IPC 或 animation.finished 中等待的旧事务。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++
    }
  }, [])
  return { ...display, rebasing, rebasingRef, cancel, setMode, receiveLayout }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function isFiniteAnimation(animation: Animation): boolean {
  return animation.effect?.getComputedTiming().iterations !== Infinity
}
