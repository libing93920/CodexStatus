import type React from 'react'

export function CloseIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m7 7 10 10M17 7 7 17"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.85"
      />
    </svg>
  )
}

export function HeartIcon(): React.JSX.Element {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 21s-6.5-4.2-9-8.1C1.2 10 2.3 6.1 5.5 5.4c2-.4 4 .5 6.5 2.7 2.5-2.2 4.5-3.1 6.5-2.7 3.2.7 4.3 4.6 2.5 7.5-2.5 3.9-9 8.1-9 8.1Z" />
    </svg>
  )
}

export function HourglassIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M7 3.75h10M7 20.25h10M7.5 3.75v3.2c0 1.5.9 2.8 2.3 3.3l3.9 1.4c1.4.5 2.3 1.8 2.3 3.3v3.2M16.5 3.75v3.2c0 1.5-.9 2.8-2.3 3.3l-3.9 1.4c-1.4.5-2.3 1.8-2.3 3.3v3.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

export function RefreshIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M20 11a8 8 0 1 0-1.5 5M20 5v6h-6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

// 额度特赦重置:环形单向箭头(区别于 RefreshIcon 双向箭头),表达"周期/恢复"语义
export function ResetIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M5.6 7A8 8 0 1 1 4 12.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
      <path
        d="M5 4v4h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

export function WindowKeeperIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M6.2 8.2A7 7 0 1 1 5.5 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M5.7 5.4v3.7h3.7M12 8.7v3.6l2.4 1.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

export function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="m7 9 5 5 5-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  )
}

export function TicketIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3.5a1.5 1.5 0 0 0 0-3z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M9 8v8"
        stroke="currentColor"
        strokeDasharray="1.5 2"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  )
}

export function SparkleIcon(): React.JSX.Element {
  return (
    <svg fill="none" viewBox="0 0 24 24">
      <path
        d="M12 3l1.8 4.8L18.6 9.6l-4.8 1.8L12 16.2l-1.8-4.8L5.4 9.6l4.8-1.8z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z"
        fill="currentColor"
      />
    </svg>
  )
}
