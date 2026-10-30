import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export function HelpTip({ text, label }: { text: string; label?: string }): ReactNode {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [portalHost, setPortalHost] = useState<Element>(document.body)
  const cancelTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
  }
  const hideSoon = (): void => {
    cancelTimer()
    timer.current = setTimeout(() => setOpen(false), 100)
  }
  const show = (): void => {
    cancelTimer()
    setPortalHost(button.current?.closest('dialog') ?? document.body)
    setOpen(true)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  useLayoutEffect(() => {
    if (!open || !button.current || !popup.current) return
    const anchor = button.current.getBoundingClientRect()
    const rect = popup.current.getBoundingClientRect()
    const left = Math.min(Math.max(12, anchor.left), window.innerWidth - rect.width - 12)
    const below = anchor.bottom + 8
    const top =
      below + rect.height > window.innerHeight - 12
        ? Math.max(12, anchor.top - rect.height - 8)
        : below
    popup.current.style.left = `${left}px`
    popup.current.style.top = `${top}px`
  }, [open, text])
  const dismiss = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      cancelTimer()
      setOpen(false)
    }
  }
  return (
    <>
      <button
        ref={button}
        className="help-button"
        type="button"
        aria-label={label ?? text}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onKeyDown={dismiss}
        onClick={show}
      >
        ?
      </button>
      {open
        ? createPortal(
            <span
              ref={popup}
              className="ui-tooltip"
              role="tooltip"
              id={id}
              onMouseEnter={cancelTimer}
              onMouseLeave={hideSoon}
              onKeyDown={dismiss}
            >
              {text}
            </span>,
            portalHost
          )
        : null}
    </>
  )
}
