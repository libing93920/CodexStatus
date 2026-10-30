import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult } from './catalog-types.ts'
import { checkAbort, errorText, readJson, time } from './catalog-io.ts'

export async function scanKimiCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const workspaces = await readDirectories(source.path, result, signal)
  for (const workspace of workspaces) {
    const workspacePath = path.join(source.path, workspace.name)
    const sessions = await readDirectories(workspacePath, result, signal)
    for (const entry of sessions) {
      checkAbort(signal)
      const directory = path.join(workspacePath, entry.name)
      const state = await readSessionState(directory, result, signal)
      if (!state || state.archived === true || object(state.custom).session_kind === 'child')
        continue
      const wirePath = path.join(directory, 'agents', 'main', 'wire.jsonl')
      try {
        const info = await lstat(wirePath)
        if (!info.isFile() || info.isSymbolicLink()) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          result.issues.push({ path: wirePath, message: errorText(error) })
        continue
      }
      const projectValue = firstPresent(state, ['cwd', 'workDir'])
      const project = projectValue.present ? projectValue.value : object(state.custom).cwd
      const summary = state.lastPrompt
      const createdAt = time(state.createdAt)
      result.sessions.push({
        sessionId: entry.name,
        path: wirePath,
        ...(typeof state.title === 'string' ? { title: state.title } : {}),
        ...(typeof summary === 'string'
          ? { summary: Array.from(summary).slice(0, 200).join('') }
          : {}),
        ...(typeof project === 'string' ? { project } : {}),
        createdAt,
        modifiedAt: time(state.updatedAt)
      })
    }
  }
  return result
}

async function readDirectories(
  directory: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<Dirent[]> {
  checkAbort(signal)
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      result.issues.push({ path: directory, message: 'Kimi 来源不是普通目录；未跟随链接' })
      return []
    }
    return (await readdir(directory, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory()
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      result.issues.push({ path: directory, message: errorText(error) })
    return []
  }
}

async function readSessionState(
  directory: string,
  result: CatalogResult,
  signal?: AbortSignal
): Promise<Record<string, unknown> | undefined> {
  for (const statePath of [
    path.join(directory, 'state.json'),
    path.join(directory, 'session-meta', 'state.json')
  ]) {
    checkAbort(signal)
    try {
      const info = await lstat(statePath)
      if (!info.isFile() || info.isSymbolicLink()) continue
      return await readJson(statePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        result.issues.push({ path: statePath, message: errorText(error) })
    }
  }
  return undefined
}

function firstPresent(
  record: Record<string, unknown>,
  keys: string[]
): { present: boolean; value: unknown } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key))
      return { present: true, value: record[key] }
  }
  return { present: false, value: undefined }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
