import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult } from './catalog-types.ts'
import { collectFiles, errorText, nonempty, readJson, time, truncate } from './catalog-io.ts'

export async function scanGrokBuildCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const summaries = await collectFiles({
    root: source.path,
    accept: (filePath) => filePath.split(/[\\/]/).at(-1) === 'summary.json',
    issues: result.issues,
    signal
  })
  for (const filePath of summaries) {
    signal?.throwIfAborted()
    try {
      const data = await readJson(filePath)
      const info = object(data.info)
      const sessionId = typeof info.id === 'string' ? info.id : undefined
      if (sessionId === undefined) continue
      const generatedTitle = nonempty(data.generated_title)
      const description = nonempty(data.session_summary)
      const cwd = typeof info.cwd === 'string' ? info.cwd : undefined
      const title = generatedTitle ?? description ?? basename(cwd)
      result.sessions.push({
        sessionId,
        path: filePath,
        ...(title ? { title: truncate(title) } : {}),
        ...(description ? { summary: truncate(description, 160) } : {}),
        ...(cwd !== undefined ? { project: cwd } : {}),
        createdAt: time(data.created_at),
        modifiedAt: time(data.last_active_at) ?? time(data.updated_at) ?? time(data.created_at)
      })
    } catch (error) {
      signal?.throwIfAborted()
      result.issues.push({ path: filePath, message: errorText(error) })
    }
  }
  return result
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function basename(value: string | undefined): string | undefined {
  return (
    value
      ?.trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || undefined
  )
}
