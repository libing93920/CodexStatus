import { useLayoutEffect, useRef, useState, type JSX } from 'react'

const MINIMAL_RING_RADIUS = 18
const MINIMAL_RING_CIRCUMFERENCE = 2 * Math.PI * MINIMAL_RING_RADIUS
const MINIMAL_RING_INNER_RADIUS = MINIMAL_RING_RADIUS - 1.1
const MINIMAL_RING_TEXT_RADIUS = MINIMAL_RING_INNER_RADIUS - 1.1
const MINIMAL_TEXT_PADDING = 0.9
const MINIMAL_QUOTA_FONT_SCALE = 1.05
const MINIMAL_QUOTA_MIN_FONT_SIZE = 10.5
const MINIMAL_QUOTA_MAX_FONT_SIZE = 14.7

export interface MinimalCapsuleProps {
  theme: string
  valueText: string
  valueColor: string | undefined
  valueFontSize: number
  progress: number | undefined
  isApiMode: boolean
}

function resolveMeasuredFontSize(
  element: HTMLElement,
  baseFontSize: number,
  isApiMode: boolean
): number {
  // getBoundingClientRect 会受极简球入场 scale(.5) 影响,必须读取布局尺寸;
  // 否则首帧会把文字误判为更窄,动画结束后又放大到环边缘。
  const width = element.offsetWidth
  const height = element.offsetHeight
  if (width <= 0 || height <= 0) {
    return baseFontSize
  }
  const renderedFontSize = Number.parseFloat(getComputedStyle(element).fontSize)
  if (!Number.isFinite(renderedFontSize) || renderedFontSize <= 0) {
    return baseFontSize
  }

  const safeRadius = isApiMode ? 18.5 : MINIMAL_RING_TEXT_RADIUS
  const safeWidth =
    2 * Math.sqrt(Math.max(0, safeRadius ** 2 - (height / 2) ** 2)) * MINIMAL_TEXT_PADDING
  const safeHeight = safeRadius * 2 * MINIMAL_TEXT_PADDING
  const widthPerFontSize = width / renderedFontSize
  const heightPerFontSize = height / renderedFontSize
  const fittedFontSize = Math.min(
    baseFontSize,
    safeWidth / widthPerFontSize,
    safeHeight / heightPerFontSize
  )
  const adjustedFontSize = isApiMode
    ? fittedFontSize
    : Math.min(
        MINIMAL_QUOTA_MAX_FONT_SIZE,
        Math.max(MINIMAL_QUOTA_MIN_FONT_SIZE, fittedFontSize * MINIMAL_QUOTA_FONT_SCALE)
      )
  return Math.max(10, Math.floor(adjustedFontSize * 10) / 10)
}

function MinimalQuotaRing({ progress }: { progress: number | undefined }): JSX.Element {
  const normalizedProgress = progress ?? 0
  const dashOffset = MINIMAL_RING_CIRCUMFERENCE * (1 - normalizedProgress / 100)

  return (
    <svg
      className="capsule__minimal-ring"
      viewBox="0 0 40 40"
      width="40"
      height="40"
      aria-hidden="true"
    >
      <circle
        className="capsule__minimal-ring-track"
        cx="20"
        cy="20"
        r={MINIMAL_RING_RADIUS}
        fill="none"
        stroke="var(--capsule-minimal-track)"
        strokeWidth="2.2"
      />
      <circle
        className="capsule__minimal-ring-progress"
        cx="20"
        cy="20"
        r={MINIMAL_RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="butt"
        strokeDasharray={MINIMAL_RING_CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 20 20)"
      />
    </svg>
  )
}

export function MinimalCapsule({
  theme,
  valueText,
  valueColor,
  valueFontSize,
  progress,
  isApiMode
}: MinimalCapsuleProps): JSX.Element {
  const valueRef = useRef<HTMLSpanElement | null>(null)
  const [measuredFontSize, setMeasuredFontSize] = useState(valueFontSize)

  useLayoutEffect(() => {
    let disposed = false
    const measure = (): void => {
      if (disposed || !valueRef.current) return
      const nextFontSize = resolveMeasuredFontSize(valueRef.current, valueFontSize, isApiMode)
      setMeasuredFontSize((current) => (current === nextFontSize ? current : nextFontSize))
    }

    const fontsReady = document.fonts?.ready
    if (fontsReady) {
      void fontsReady.then(measure)
    } else {
      measure()
    }

    return () => {
      disposed = true
    }
  }, [isApiMode, theme, valueFontSize, valueText])

  return (
    <div className="capsule__minimal" aria-hidden="true" style={{ color: valueColor }}>
      <span className="capsule__minimal-deco" />
      {!isApiMode ? <MinimalQuotaRing progress={progress} /> : null}
      <span
        ref={valueRef}
        className="capsule__minimal-value"
        style={{ fontSize: `${measuredFontSize}px` }}
      >
        {valueText}
      </span>
    </div>
  )
}
