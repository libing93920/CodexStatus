import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

type DirectoryOverrides = Record<string, string | undefined>
const READ_ATTEMPTS = 5
const READ_RETRY_MS = 200

const DIRECTORY_OVERRIDE_KEYS = [
  'claudeConfigDir',
  'codexConfigDir',
  'geminiConfigDir',
  'grokConfigDir',
  'openclawConfigDir',
  'hermesConfigDir',
  'piConfigDir',
  'ompConfigDir'
] as const

export async function readPathOverrides(home: string): Promise<DirectoryOverrides> {
  let settings: Record<string, unknown>
  try {
    const contents = await readSettings(path.join(home, '.cc-switch', 'settings.json'))
    settings = parseSettingsObject(contents)
  } catch {
    return {}
  }
  return Object.fromEntries(DIRECTORY_OVERRIDE_KEYS.map((key) => [key, nonempty(settings[key])]))
}

async function readSettings(file: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || attempt >= READ_ATTEMPTS)
        throw error
      await delay(READ_RETRY_MS)
    }
  }
}

function parseSettingsObject(contents: string): Record<string, unknown> {
  const normalized = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents
  try {
    return object(JSON.parse(normalized))
  } catch {
    const firstObject = extractFirstObject(normalized)
    if (!firstObject) return {}
    try {
      return object(JSON.parse(firstObject))
    } catch {
      return {}
    }
  }
}

function extractFirstObject(contents: string): string | undefined {
  const start = contents.search(/\S/)
  if (start < 0 || contents[start] !== '{') return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < contents.length; index++) {
    const char = contents[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return contents.slice(start, index + 1)
  }
  return undefined
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nonempty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}
