import path from 'node:path'
import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult, CatalogSession } from './catalog-types.ts'
import {
  basename,
  checkAbort,
  collectFiles,
  errorText,
  extractText,
  headTail,
  nonempty,
  object,
  parseLine,
  string,
  tailText,
  time,
  truncate
} from './catalog-io.ts'

const RELOCATED_TAIL_BYTES = 64 * 1024

export async function scanClaudeCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  const result: CatalogResult = { sessions: [], issues: [] }
  const files = await collectFiles({
    root: source.path,
    issues: result.issues,
    signal,
    accept: (file) => {
      const name = path.basename(file)
      return name.endsWith('.jsonl') && !name.startsWith('agent-') && name !== 'journal.jsonl'
    }
  })
  for (const file of files) {
    checkAbort(signal)
    try {
      result.sessions.push(await parseClaudeSession(file, signal))
    } catch (error) {
      checkAbort(signal)
      result.issues.push({ path: file, message: errorText(error) })
    }
  }
  return result
}

async function parseClaudeSession(file: string, signal?: AbortSignal): Promise<CatalogSession> {
  const { head, tail } = await headTail(file, signal)
  const session: CatalogSession = { sessionId: path.basename(file, '.jsonl'), path: file }
  let id: string | undefined
  let firstUser: string | undefined
  for (const line of head) {
    const record = parseLine(line)
    const message = object(record.message)
    id ??= string(record.sessionId)
    session.project ??= string(record.cwd)
    session.createdAt ??= time(record.timestamp)
    if (firstUser === undefined && (record.type === 'user' || message.role === 'user')) {
      const text = extractText(message.content).trim()
      if (usableText(text)) firstUser = text
    }
    if (
      id !== undefined &&
      session.project !== undefined &&
      session.createdAt !== undefined &&
      firstUser !== undefined
    )
      break
  }
  session.sessionId = id ?? session.sessionId
  let customTitle: string | undefined
  for (const line of tail.reverse()) {
    const record = parseLine(line)
    session.modifiedAt ??= time(record.timestamp)
    if (customTitle === undefined && record.type === 'custom-title')
      customTitle = nonempty(record.customTitle)
    if (session.summary === undefined && record.isMeta !== true) {
      const text = extractText(object(record.message).content)
      if (usableText(text.trim())) session.summary = truncate(text, 160)
    }
    if (
      session.modifiedAt !== undefined &&
      session.summary !== undefined &&
      customTitle !== undefined
    )
      break
  }
  const relocated = await lastRelocated(file)
  if (relocated !== undefined) session.project = relocated
  session.title =
    customTitle !== undefined
      ? truncate(customTitle)
      : firstUser !== undefined
        ? truncate(firstUser)
        : basename(session.project)
  return session
}

function usableText(text: string): boolean {
  return (
    !!text &&
    !text.startsWith('<command-name>') &&
    !text.includes('<local-command-caveat>') &&
    !['<local-command-stdout>', '<local-command-stderr>', '<task-notification>'].some((prefix) =>
      text.startsWith(prefix)
    )
  )
}

async function lastRelocated(file: string): Promise<string | undefined> {
  const tail = await tailText(file, RELOCATED_TAIL_BYTES)
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"relocated"')) continue
    const record = parseLine(line)
    if (record.type === 'relocated' && nonempty(record.relocatedCwd))
      return nonempty(record.relocatedCwd)
  }
  return undefined
}
