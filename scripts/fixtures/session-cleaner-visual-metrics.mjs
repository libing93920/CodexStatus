/* eslint-disable @typescript-eslint/explicit-function-return-type */
export const METRIC_SCRIPT = `(() => {
  const visible = (element) => {
    if (!element) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
  }
  const firstVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(visible) ?? null
  const rect = (element) => {
    if (!element) return null
    const bounds = element.getBoundingClientRect()
    return { x: Number(bounds.x.toFixed(2)), y: Number(bounds.y.toFixed(2)), width: Number(bounds.width.toFixed(2)), height: Number(bounds.height.toFixed(2)) }
  }
  const box = (element) => {
    if (!element) return null
    const style = getComputedStyle(element)
    return {
      rect: rect(element),
      borderRadius: style.borderRadius,
      border: {
        top: [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
        right: [style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
        bottom: [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
        left: [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor]
      }
    }
  }
  const heading = firstVisible('h1')
  const bodyStyle = getComputedStyle(document.body)
  const headingStyle = heading ? getComputedStyle(heading) : null
  const overview = firstVisible('.overview-focus')
  const cards = overview ? Array.from(overview.children).filter(visible).map((element) => ({ className: element.className, ...box(element) })) : []
  const amount = firstVisible('.opportunity-amount')
  const candidate = amount?.firstElementChild ?? null
  const candidateStyle = candidate ? getComputedStyle(candidate) : null
  const ring = firstVisible('.composition-ring')
  const buttons = Array.from(document.querySelectorAll('button.button')).filter(visible).map(rect)
  return {
    viewport: { width: innerWidth, height: innerHeight },
    shell: {
      sidebar: rect(firstVisible('.sidebar')),
      topbar: rect(firstVisible('.topbar')),
      bodyFontSize: bodyStyle.fontSize,
      bodyFontFamily: bodyStyle.fontFamily,
      headingText: heading?.textContent.trim() ?? null,
      headingId: heading?.id ?? null,
      headingFontSize: headingStyle?.fontSize ?? null,
      buttonRects: buttons
    },
    overview: {
      cards,
      candidate: candidate && candidateStyle ? {
        text: candidate.textContent.trim(),
        fontSize: candidateStyle.fontSize,
        color: candidateStyle.color
      } : null,
      ring: rect(ring)
    },
    sourceRows: Array.from(document.querySelectorAll('.source-card')).filter(visible).map((element) => rect(element))
  }
})()`

function closeTo(actual, expected, tolerance = 0.5) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
}

function addFailure(failures, label, actual, expected) {
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function expectNear(failures, label, actual, expected, tolerance = 0.5) {
  if (!closeTo(actual, expected, tolerance))
    addFailure(failures, label, actual, `${expected} ± ${tolerance}px`)
}

function isGreen(value) {
  const channels = value?.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  return Boolean(
    channels &&
    Number(channels[2]) > Number(channels[1]) &&
    Number(channels[2]) > Number(channels[3])
  )
}

function validateSide(failures, record, side, pages) {
  const pageSpec = pages.find((entry) => entry.key === record.page)
  const { viewport, page, dom } = record
  const label = `${viewport.width}x${viewport.height} ${side} ${page}`
  expectNear(failures, `${label} viewport width`, dom.viewport?.width, viewport.width, 0)
  expectNear(failures, `${label} viewport height`, dom.viewport?.height, viewport.height, 0)
  expectNear(failures, `${label} sidebar width`, dom.shell?.sidebar?.width, 176)
  expectNear(failures, `${label} topbar height`, dom.shell?.topbar?.height, 44)
  expectNear(failures, `${label} body font size`, Number.parseFloat(dom.shell?.bodyFontSize), 13, 0)
  expectNear(
    failures,
    `${label} heading font size`,
    Number.parseFloat(dom.shell?.headingFontSize),
    22,
    0
  )
  if (
    !dom.shell?.bodyFontFamily ||
    (side === 'current' && !/inter|segoe ui variable/i.test(dom.shell.bodyFontFamily))
  ) {
    addFailure(
      failures,
      `${label} body font family`,
      dom.shell?.bodyFontFamily,
      'Inter or Segoe UI Variable in current renderer'
    )
  }
  if (dom.shell?.headingText !== pageSpec?.label) {
    addFailure(failures, `${label} heading text`, dom.shell?.headingText, pageSpec?.label)
  }
  if (side === 'current' && dom.shell?.headingId !== pageSpec?.headingId) {
    addFailure(failures, `${label} heading id`, dom.shell?.headingId, pageSpec?.headingId)
  }
  if (!dom.shell?.buttonRects?.length)
    addFailure(failures, `${label} visible buttons`, dom.shell?.buttonRects, 'at least one .button')
  for (const [index, button] of (dom.shell?.buttonRects ?? []).entries()) {
    const expected =
      index === 1 && page === 'overview' ? 32 : index === 1 && page === 'review' ? 36 : 34
    expectNear(failures, `${label} button ${index + 1} height`, button?.height, expected)
  }
}

function validateOverviewPair(failures, reference, current) {
  for (const record of [reference, current]) {
    const { viewport, side, dom } = record
    const label = `${viewport.width}x${viewport.height} ${side} overview`
    const cards = dom.overview?.cards ?? []
    if (cards.length !== 3) addFailure(failures, `${label} card count`, cards.length, 3)
    if (cards.length === 3) {
      const baseWidth = cards[1].rect?.width
      const ratios = cards.map((card) => card.rect?.width / baseWidth)
      for (const [index, expected] of [1.25, 1, 0.8].entries()) {
        expectNear(failures, `${label} card ratio ${index + 1}`, ratios[index], expected, 0.04)
      }
      for (const [index, card] of cards.entries()) {
        expectNear(
          failures,
          `${label} card ${index + 1} radius`,
          Number.parseFloat(card.borderRadius),
          11,
          0
        )
        if (!card.border?.top || card.border.top[0] !== '1px' || card.border.top[1] !== 'solid') {
          addFailure(failures, `${label} card ${index + 1} border`, card.border?.top, [
            '1px',
            'solid',
            'reference color'
          ])
        }
      }
    }
    expectNear(
      failures,
      `${label} candidate value font`,
      Number.parseFloat(dom.overview?.candidate?.fontSize),
      43,
      0
    )
    if (!isGreen(dom.overview?.candidate?.color))
      addFailure(
        failures,
        `${label} candidate color`,
        dom.overview?.candidate?.color,
        'green computed color'
      )
    expectNear(failures, `${label} ring width`, dom.overview?.ring?.width, 124, 0)
    expectNear(failures, `${label} ring height`, dom.overview?.ring?.height, 124, 0)
  }
  const referenceCards = reference.dom.overview?.cards ?? []
  const currentCards = current.dom.overview?.cards ?? []
  if (referenceCards.length === 3 && currentCards.length === 3) {
    for (const index of [0, 1, 2]) {
      if (
        JSON.stringify(currentCards[index].border) !== JSON.stringify(referenceCards[index].border)
      ) {
        addFailure(
          failures,
          `${current.viewport.width}x${current.viewport.height} current card ${index + 1} exact border`,
          currentCards[index].border,
          referenceCards[index].border
        )
      }
    }
  }
  if (reference.dom.overview?.candidate?.color !== current.dom.overview?.candidate?.color) {
    addFailure(
      failures,
      `${current.viewport.width}x${current.viewport.height} candidate color vs reference`,
      current.dom.overview?.candidate?.color,
      reference.dom.overview?.candidate?.color
    )
  }
}

function validateSourcePair(failures, reference, current) {
  for (const record of [reference, current]) {
    const { viewport, side, dom } = record
    const heights = (dom.sourceRows ?? []).map((row) => row.height)
    const label = `${viewport.width}x${viewport.height} ${side} source rows`
    if (heights.length !== 7) addFailure(failures, `${label} count`, heights.length, 7)
    for (const [index, height] of heights.entries())
      expectNear(
        failures,
        `${label} ${index + 1}`,
        height,
        index === heights.length - 1 ? 64 : 65,
        0.5
      )
  }
  const referenceRows = reference.dom.sourceRows ?? []
  const currentRows = current.dom.sourceRows ?? []
  if (referenceRows.length === currentRows.length) {
    for (const [index, row] of referenceRows.entries()) {
      expectNear(
        failures,
        `${current.viewport.width}x${current.viewport.height} source row ${index + 1} vs reference`,
        currentRows[index]?.height,
        row.height,
        0.5
      )
    }
  }
}

export function validateVisualReport(report, pages) {
  const failures = []
  for (const pair of report.comparisons) {
    const reference = {
      viewport: pair.viewport,
      page: pair.page,
      side: 'reference',
      dom: pair.reference
    }
    const current = { viewport: pair.viewport, page: pair.page, side: 'current', dom: pair.current }
    validateSide(failures, reference, 'reference', pages)
    validateSide(failures, current, 'current', pages)
    if (pair.page === 'overview') validateOverviewPair(failures, reference, current)
    if (pair.page === 'sources') validateSourcePair(failures, reference, current)
  }
  return failures
}

export function printVisualMeasurements(report) {
  for (const pair of report.comparisons) {
    const ref = pair.reference?.shell ?? {}
    const current = pair.current?.shell ?? {}
    const delta = (left, right) =>
      typeof left === 'number' && typeof right === 'number' ? (right - left).toFixed(2) : 'n/a'
    console.log(
      `METRIC ${pair.viewport.width}x${pair.viewport.height} ${pair.page}: sidebar ${ref.sidebar?.width}/${current.sidebar?.width} Δ${delta(ref.sidebar?.width, current.sidebar?.width)}; topbar ${ref.topbar?.height}/${current.topbar?.height} Δ${delta(ref.topbar?.height, current.topbar?.height)}; font ${ref.bodyFontSize} ${ref.bodyFontFamily} / ${current.bodyFontSize} ${current.bodyFontFamily}; h1 ${ref.headingFontSize}/${current.headingFontSize}; buttons ${JSON.stringify(ref.buttonRects?.map((box) => box.height))}/${JSON.stringify(current.buttonRects?.map((box) => box.height))}`
    )
    if (pair.page === 'overview') {
      console.log(
        `METRIC ${pair.viewport.width}x${pair.viewport.height} overview details: ratios ${JSON.stringify(pair.reference?.overview?.cards?.map((card) => card.rect?.width))}/${JSON.stringify(pair.current?.overview?.cards?.map((card) => card.rect?.width))}; candidate ${pair.reference?.overview?.candidate?.fontSize} ${pair.reference?.overview?.candidate?.color}/${pair.current?.overview?.candidate?.fontSize} ${pair.current?.overview?.candidate?.color}; ring ${pair.reference?.overview?.ring?.width}x${pair.reference?.overview?.ring?.height}/${pair.current?.overview?.ring?.width}x${pair.current?.overview?.ring?.height}`
      )
    }
    if (pair.page === 'sources') {
      console.log(
        `METRIC ${pair.viewport.width}x${pair.viewport.height} source rows: ref ${JSON.stringify(pair.reference?.sourceRows?.map((row) => row.height))}; current ${JSON.stringify(pair.current?.sourceRows?.map((row) => row.height))}`
      )
    }
  }
}
