/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usageSource = await readFile(
  resolve(repositoryRoot, 'src/renderer/src/components/usage.tsx'),
  'utf8'
)
const appSource = await readFile(resolve(repositoryRoot, 'src/renderer/src/App.tsx'), 'utf8')
const appFile = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true)

function findNode(root, predicate) {
  if (predicate(root)) return root
  for (const child of root.getChildren()) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return undefined
}

function createUsageCardHarness(codexStatus) {
  const hookState = []
  const effectDeps = []
  const effectCleanups = []
  let hookIndex = 0
  let scheduledEffects = []

  const react = {
    useState(initialValue) {
      const index = hookIndex++
      if (!(index in hookState)) {
        hookState[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      }
      return [
        hookState[index],
        (nextValue) => {
          hookState[index] =
            typeof nextValue === 'function' ? nextValue(hookState[index]) : nextValue
        }
      ]
    },
    useRef(initialValue) {
      const index = hookIndex++
      if (!(index in hookState)) hookState[index] = { current: initialValue }
      return hookState[index]
    },
    useEffect(create, dependencies) {
      const index = hookIndex++
      const previous = effectDeps[index]
      const unchanged =
        dependencies !== undefined &&
        previous !== undefined &&
        dependencies.length === previous.length &&
        dependencies.every((dependency, i) => Object.is(dependency, previous[i]))
      if (!unchanged) scheduledEffects.push({ index, create, dependencies })
    }
  }

  const element = (type, props) => ({ type, props })
  const copy = {
    usage: 'Usage',
    usage1d: '1d',
    usage7d: '7d',
    usage30d: '30d',
    rangeCustom: 'Custom',
    refreshing: 'Refreshing',
    usageEmpty: 'Empty',
    usageTotal: 'Total',
    usageInput: 'Input',
    usageOutput: 'Output',
    usageCacheHit: 'Cache hit',
    usageCost: 'Cost',
    usageEstimated: 'Estimated',
    spendReal: 'Real spend',
    usageCached: 'Cached',
    usageReasoning: 'Reasoning',
    modelUsage: 'Models',
    modelOther: 'Other'
  }
  const module = { exports: {} }
  const context = vm.createContext({
    exports: module.exports,
    module,
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === '../copy') return { COPY: { 'en-US': copy, 'zh-CN': copy } }
      if (name === '../formatters') {
        return {
          createMetricProgressStyle: () => ({}),
          formatAbsoluteDate: () => '',
          formatCacheHit: () => '0%',
          formatCapsuleResetTime: () => '',
          formatCompactTokens: (value) => String(value),
          formatDayLabel: () => '',
          formatRelativeDuration: () => '',
          formatUsd: (value) => `$${value}`,
          shouldShowDateLabel: () => true
        }
      }
      if (name === '../ui-constants') return { PANEL_TAB_MOTION_CLEAR_MS: 300 }
      if (name === './controls') return { SegmentedControl: () => null }
      if (name === './icons') return { ChevronDownIcon: () => null, WindowKeeperIcon: () => null }
      throw new Error(`unexpected module: ${name}`)
    },
    window: { codexStatus, clearTimeout: () => 0 }
  })
  const compiled = ts.transpileModule(usageSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX
    }
  }).outputText
  vm.runInContext(compiled, context)

  function render(props) {
    hookIndex = 0
    scheduledEffects = []
    const tree = module.exports.UsageCard(props)
    return { tree, effects: scheduledEffects }
  }

  function commit(effects) {
    for (const effect of effects) {
      effectCleanups[effect.index]?.()
      effectDeps[effect.index] = effect.dependencies
      effectCleanups[effect.index] = effect.create()
    }
  }

  return { render, commit, exports: module.exports }
}

function findElement(root, predicate) {
  if (!root || typeof root !== 'object') return undefined
  if (predicate(root)) return root
  const props = root.props
  if (!props) return undefined
  for (const value of Object.values(props)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findElement(child, predicate)
        if (found) return found
      }
    } else {
      const found = findElement(value, predicate)
      if (found) return found
    }
  }
  return undefined
}

function usageOverview(cost) {
  return {
    available: true,
    generatedAt: 'snapshot',
    days: [{ date: '2026-10-19', input: 100, cachedInput: 20, output: 50, reasoning: 0, cost }],
    totals: { input: 100, cachedInput: 20, output: 50, reasoning: 0, total: 150, cost },
    models: []
  }
}

function costValue(view, exports) {
  const item = findElement(
    view.tree,
    (node) => node.type === exports.UsageSummaryItem && node.props.label === 'Cost'
  )
  return item?.props.value
}

function realSpendHint(view) {
  return Boolean(
    findElement(
      view.tree,
      (node) =>
        node.props?.className === 'usage-card__spend-hint' && node.props.children === 'Real spend'
    )
  )
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

test('token usage refreshes for each snapshot and ignores results from an older snapshot', async () => {
  const tokenRequests = []
  const harness = createUsageCardHarness({
    getTokenUsage(window) {
      return new Promise((resolve) => tokenRequests.push({ window, resolve }))
    },
    getSpendUsage() {
      throw new Error('non-API mode must not request billed spend')
    }
  })
  const firstProps = { locale: 'en-US', authMode: 'chatgpt', generatedAt: 'snapshot-1' }
  const firstView = harness.render(firstProps)
  harness.commit(firstView.effects)
  const nextProps = { ...firstProps, generatedAt: 'snapshot-2' }
  const nextView = harness.render(nextProps)
  harness.commit(nextView.effects)

  assert.deepEqual(
    tokenRequests.map((request) => request.window),
    ['1d', '7d', '30d', '1d', '7d', '30d']
  )
  for (const request of tokenRequests.slice(0, 3)) request.resolve(usageOverview(111))
  for (const request of tokenRequests.slice(3)) request.resolve(usageOverview(222))
  await flushPromises()

  const currentView = harness.render(nextProps)
  assert.equal(costValue(currentView, harness.exports), '$222')
})

test('real spend is cleared outside API mode and unavailable API spend falls back to estimate', async () => {
  const tokenRequests = []
  const spendRequests = []
  const harness = createUsageCardHarness({
    getTokenUsage(window) {
      const batch = Math.floor(tokenRequests.length / 3)
      tokenRequests.push(window)
      return Promise.resolve(usageOverview([7, 9, 11, 13][batch]))
    },
    getSpendUsage(window) {
      return new Promise((resolve) => spendRequests.push({ window, resolve }))
    }
  })
  const apiProps = { locale: 'en-US', authMode: 'api', generatedAt: 'snapshot-1' }
  const initialView = harness.render(apiProps)
  harness.commit(initialView.effects)
  await flushPromises()
  for (const request of spendRequests) {
    request.resolve({ available: true, generatedAt: 'billing-1', days: [], total: 42 })
  }
  await flushPromises()
  const loadedApiView = harness.render(apiProps)
  assert.equal(costValue(loadedApiView, harness.exports), '$42')
  assert.equal(realSpendHint(loadedApiView), true)

  const authProps = { ...apiProps, authMode: 'chatgpt', generatedAt: 'snapshot-2' }
  const authView = harness.render(authProps)
  harness.commit(authView.effects)
  await flushPromises()
  const loadedAuthView = harness.render(authProps)
  assert.equal(costValue(loadedAuthView, harness.exports), '$9')
  assert.equal(realSpendHint(loadedAuthView), false)

  const refreshedApiProps = { ...apiProps, generatedAt: 'snapshot-3' }
  const refreshedApiView = harness.render(refreshedApiProps)
  harness.commit(refreshedApiView.effects)
  await flushPromises()
  const waitingForBillingView = harness.render(refreshedApiProps)
  assert.equal(costValue(waitingForBillingView, harness.exports), '$11')
  assert.equal(realSpendHint(waitingForBillingView), false)
  assert.equal(spendRequests.length, 6)

  const nextRefreshProps = { ...refreshedApiProps, generatedAt: 'snapshot-4' }
  const nextRefreshView = harness.render(nextRefreshProps)
  harness.commit(nextRefreshView.effects)
  await flushPromises()
  const clearedRefreshView = harness.render(nextRefreshProps)
  assert.equal(costValue(clearedRefreshView, harness.exports), '$13')
  assert.equal(realSpendHint(clearedRefreshView), false)
  assert.equal(spendRequests.length, 9)

  for (const request of spendRequests.slice(3, 6)) {
    request.resolve({ available: true, generatedAt: 'late-billing', days: [], total: 99 })
  }
  await flushPromises()
  const afterLateResultView = harness.render(nextRefreshProps)
  assert.equal(costValue(afterLateResultView, harness.exports), '$13')
  assert.equal(realSpendHint(afterLateResultView), false)

  for (const request of spendRequests.slice(6, 9)) {
    request.resolve({ available: false, generatedAt: 'billing-2', days: [], total: 0 })
  }
  await flushPromises()
  const unavailableBillingView = harness.render(nextRefreshProps)
  assert.equal(costValue(unavailableBillingView, harness.exports), '$13')
  assert.equal(realSpendHint(unavailableBillingView), false)
})

test('App passes snapshot generatedAt to UsageCard', () => {
  const usageCard = findNode(
    appFile,
    (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(appFile) === 'UsageCard'
  )
  assert.ok(usageCard, 'missing UsageCard render')
  const generatedAt = usageCard.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(appFile) === 'generatedAt'
  )
  assert.ok(generatedAt && ts.isJsxExpression(generatedAt.initializer), 'missing generatedAt prop')
  assert.equal(generatedAt.initializer.expression.getText(appFile), 'snapshot.generatedAt')
})
