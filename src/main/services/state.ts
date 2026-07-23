import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  DEFAULT_PANEL_PREFERENCES,
  DEFAULT_WINDOW_PREFERENCES,
  normalizePanelPreferences,
  normalizeSettings,
  normalizeWindowPreferences,
  type PanelPreferences,
  type PersistedState,
  type WindowPreferences
} from '../../shared/capsule'

const STATE_FILE_NAME = 'codex-status-state.json'

export async function loadPersistedState(): Promise<PersistedState> {
  const filePath = getStateFilePath()

  try {
    const content = await fs.readFile(filePath, 'utf8')
    const parsed = getRecord(JSON.parse(content))

    return {
      settings: normalizeSettings(getRecord(parsed?.settings) as Partial<typeof DEFAULT_SETTINGS> | undefined),
      window: normalizeWindowPreferences(getRecord(parsed?.window) as Partial<WindowPreferences> | undefined),
      panel: normalizePanelPreferences(getRecord(parsed?.panel) as Partial<PanelPreferences> | undefined)
    }
  } catch {
    return createDefaultState()
  }
}

export async function savePersistedState(state: PersistedState): Promise<void> {
  const filePath = getStateFilePath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function createDefaultState(): PersistedState {
  return {
    settings: { ...DEFAULT_SETTINGS },
    window: { ...DEFAULT_WINDOW_PREFERENCES },
    panel: { ...DEFAULT_PANEL_PREFERENCES }
  }
}

function getStateFilePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE_NAME)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
