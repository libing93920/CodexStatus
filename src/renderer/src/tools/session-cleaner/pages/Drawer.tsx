import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../components'

export function Drawer({
  title,
  className = '',
  onClose,
  children
}: {
  title: string
  className?: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const reference = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = reference.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])
  return (
    <dialog
      ref={reference}
      className={'calm-drawer ' + className}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="calm-drawer-shell">
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={'关闭' + title}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}
