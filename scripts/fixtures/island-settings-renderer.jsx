import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { IslandSettingsCard } from '../../src/renderer/src/island/IslandSettingsCard'
import { SegmentedControl } from '../../src/renderer/src/components/controls'
import { THEME_OPTIONS } from '../../src/renderer/src/copy'

const root = createRoot(document.getElementById('root'))
let state = { theme: 'midnight', locale: 'zh-CN', enabled: true, displayMode: 'island' }
const changes = []

function update(preferences) {
  changes.push({ ...preferences })
  state = { ...state, ...preferences }
  render()
}

function Fixture() {
  const { theme, locale, enabled, displayMode } = state
  const options = [
    { value: 'island', label: locale === 'zh-CN' ? '灵动岛' : 'Dynamic Island' },
    { value: 'taskbar', label: locale === 'zh-CN' ? '任务栏' : 'Taskbar' }
  ]
  return (
    <div className="app-shell app-shell--panel" data-theme={theme}>
      <main className="panel panel--settings">
        <button id="before" type="button">
          Before
        </button>
        <section className="settings-section">
          <p className="settings-section__title">{theme}</p>
          <IslandSettingsCard
            locale={locale}
            preferences={{ enabled, displayMode }}
            snapshot={{ visibility: 'waiting', tasks: [], connection: { hooks: true, ipc: true } }}
            onChange={update}
          />
        </section>
        <button id="after" type="button">
          After
        </button>
        <section className="settings-section reference">
          <SegmentedControl
            value={displayMode}
            options={options}
            disabled={!enabled}
            onChange={() => {}}
          />
        </section>
      </main>
    </div>
  )
}

function render() {
  flushSync(() => root.render(<Fixture />))
}

window.islandSettingsFixture = {
  themes: THEME_OPTIONS.map((theme) => theme.value),
  reset(next = {}) {
    state = { theme: 'midnight', locale: 'zh-CN', enabled: true, displayMode: 'island', ...next }
    changes.length = 0
    render()
  },
  preferences: () => ({ enabled: state.enabled, displayMode: state.displayMode }),
  changes: () => changes.map((change) => ({ ...change }))
}
render()
