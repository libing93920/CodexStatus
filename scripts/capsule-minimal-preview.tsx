import { createRoot } from 'react-dom/client'
import type { JSX } from 'react'
import '../src/renderer/src/assets/main.css'
import '../src/renderer/src/assets/themes.css'
import './capsule-minimal-preview.css'
import { MinimalCapsule } from '../src/renderer/src/MinimalCapsule'
import { fitFontSize, formatCapsuleTokens } from '../src/renderer/src/formatters'
import { resolveMinimalMetricColor } from '../src/renderer/src/minimal-quota'

const MINIMAL_BALL_SIZE = 40

function resolveProductionMinimalFontSize(
  valueText: string,
  theme: string,
  isApiMode: boolean
): number {
  const fontSize = fitFontSize(
    valueText,
    Math.max(10, Math.round(MINIMAL_BALL_SIZE * 0.36)),
    Math.max(16, MINIMAL_BALL_SIZE - 8)
  )
  return theme === 'memphis' && !isApiMode ? Math.min(fontSize, 12) : fontSize
}

const themes = [
  'midnight',
  'aurora',
  'cyber',
  'titan',
  'poster',
  'memphis',
  'cockpit',
  'inksong',
  'greenhouse',
  'swiss'
] as const

const previewCases = [
  ...themes.flatMap((theme) => [
    { theme, state: '100', valueText: '100%', progress: 100, isApiMode: false },
    { theme, state: '0', valueText: '0%', progress: 0, isApiMode: false }
  ]),
  { theme: 'midnight', state: '72', valueText: '72%', progress: 72, isApiMode: false },
  { theme: 'poster', state: '5', valueText: '5%', progress: 5, isApiMode: false },
  { theme: 'memphis', state: '50', valueText: '50%', progress: 50, isApiMode: false },
  { theme: 'inksong', state: 'empty', valueText: '--', progress: undefined, isApiMode: false },
  {
    theme: 'cyber',
    state: 'api-10k',
    valueText: formatCapsuleTokens(120000, 'zh-CN'),
    progress: undefined,
    isApiMode: true
  },
  {
    theme: 'cyber',
    state: 'api-100m',
    valueText: formatCapsuleTokens(123456789, 'zh-CN'),
    progress: undefined,
    isApiMode: true
  }
] as const

export function Preview(): JSX.Element {
  return (
    <main className="minimal-preview">
      {previewCases.map((previewCase) => (
        <div
          className="minimal-preview__sample"
          data-api={previewCase.isApiMode}
          data-state={previewCase.state}
          data-theme={previewCase.theme}
          id={`sample-${previewCase.theme}-${previewCase.state}`}
          key={`${previewCase.theme}-${previewCase.state}`}
        >
          <section className="capsule capsule--capsule capsule--minimal has-update" role="button">
            <MinimalCapsule
              theme={previewCase.theme}
              valueText={previewCase.valueText}
              valueColor={
                previewCase.isApiMode
                  ? undefined
                  : resolveMinimalMetricColor(previewCase.progress, previewCase.theme)
              }
              valueFontSize={resolveProductionMinimalFontSize(
                previewCase.valueText,
                previewCase.theme,
                previewCase.isApiMode
              )}
              progress={previewCase.progress}
              isApiMode={previewCase.isApiMode}
            />
          </section>
          <span className="minimal-preview__label">
            {previewCase.theme} · {previewCase.state}
          </span>
        </div>
      ))}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
