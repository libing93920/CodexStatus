/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

export const DAY_MS = 24 * 60 * 60 * 1000
export const CLAUDE_AGE_DAYS = 100
export const PI_AGE_DAYS = 20
export const RESTORE_POLL_ATTEMPTS = 40
export const RESTORE_POLL_INTERVAL_MS = 100
export const SETTINGS = { keepRecentDays: 14, olderSessionDays: 14, logAgeDays: 30, alertGiB: 10 }
const execute = promisify(execFile)

async function createClaudeFixture(directory) {
  const sessionId = randomUUID()
  const sessionTitle = 'temporary integration fixture'
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  const userId = randomUUID()
  const file = join(directory, `claude-session-${sessionId}.jsonl`)
  const modifiedAt = new Date(Date.now() - CLAUDE_AGE_DAYS * DAY_MS)
  const lines = [
    {
      type: 'user',
      uuid: userId,
      parentUuid: null,
      sessionId,
      timestamp: modifiedAt.toISOString(),
      cwd: directory,
      message: { role: 'user', content: [{ type: 'text', text: sessionTitle }] }
    },
    {
      type: 'assistant',
      uuid: randomUUID(),
      parentUuid: userId,
      sessionId,
      timestamp: modifiedAt.toISOString(),
      cwd: directory,
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'temporary integration reply' }],
        usage: {
          input_tokens: 101,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 23,
          output_tokens: 17
        }
      }
    }
  ]
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  await writeFile(file, text, 'utf8')
  await utimes(file, modifiedAt, modifiedAt)
  return { file, text, sessionId, messageId, sessionTitle }
}

async function createPiFixture(directory) {
  const sessionId = randomUUID()
  const userId = randomUUID()
  const file = join(directory, `pi-session-${sessionId}.jsonl`)
  const modifiedAt = new Date(Date.now() - PI_AGE_DAYS * DAY_MS)
  const lines = [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      cwd: directory,
      createdAt: modifiedAt.toISOString()
    },
    {
      type: 'message',
      id: userId,
      parentId: null,
      timestamp: modifiedAt.toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'temporary Pi fixture' }] }
    },
    {
      type: 'message',
      id: randomUUID(),
      parentId: userId,
      timestamp: modifiedAt.toISOString(),
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        content: [{ type: 'text', text: 'temporary Pi reply' }],
        usage: {
          input: 40,
          output: 12,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 52,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    }
  ]
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  await writeFile(file, text, 'utf8')
  await utimes(file, modifiedAt, modifiedAt)
  return { file, text, sessionId }
}

async function createUnknownFixture(directory) {
  const file = join(directory, `unknown-${randomUUID()}.jsonl`)
  const text = `${JSON.stringify({ type: 'session', id: randomUUID(), note: 'read-only fixture' })}\n`
  await writeFile(file, text, 'utf8')
  return { file, text }
}

async function createCodexFixture(directory, label) {
  const sessionId = randomUUID()
  const file = join(directory, `rollout-${sessionId}.jsonl`)
  const title = `temporary Codex ${label} fixture`
  const timestamp = new Date(Date.now() - CLAUDE_AGE_DAYS * DAY_MS).toISOString()
  const records = [
    { type: 'session_meta', timestamp, payload: { id: sessionId, cwd: directory } },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: title }]
      }
    }
  ]
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(file, text, 'utf8')
  return { file, text, title }
}

export function createSources(directories) {
  return [
    {
      id: 'fixture-claude',
      kind: 'claude',
      name: 'Claude fixture',
      path: directories[0],
      origin: 'manual',
      capability: 'sessions',
      note: '临时集成验收来源'
    },
    {
      id: 'fixture-pi',
      kind: 'pi',
      name: 'Pi fixture',
      layout: 'flat',
      path: directories[1],
      origin: 'manual',
      capability: 'sessions',
      note: '临时集成验收来源'
    },
    {
      id: 'fixture-unknown',
      kind: 'unknown',
      name: 'Unknown fixture',
      path: directories[2],
      origin: 'manual',
      capability: 'files',
      note: '临时集成验收来源，只读'
    },
    ...directories.slice(3).map((directory, index) => ({
      id: index === 0 ? 'fixture-codex-main' : 'fixture-codex-archive',
      kind: 'codex',
      name: 'Codex',
      path: directory,
      origin: 'manual',
      capability: 'sessions',
      note: '临时 Codex 普通/归档目录分组验收来源，只读'
    }))
  ]
}

async function writeConfig(userData, sources) {
  const config = join(userData, 'tools', 'session-cleaner', 'config.json')
  await mkdir(dirname(config), { recursive: true })
  await writeFile(
    config,
    JSON.stringify({ sources, protectedIds: [], settings: SETTINGS }, null, 2),
    'utf8'
  )
}

export async function createSessionCleanerFixtures(scratch, userData) {
  const root = join(scratch, 'fixtures')
  const directories = ['claude', 'pi', 'unknown', 'codex/sessions', 'codex/archived_sessions'].map(
    (name) => join(root, name)
  )
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
  const [claude, pi, unknown, codexMain, codexArchive] = await Promise.all([
    createClaudeFixture(directories[0]),
    createPiFixture(directories[1]),
    createUnknownFixture(directories[2]),
    createCodexFixture(directories[3], 'regular'),
    createCodexFixture(directories[4], 'archived')
  ])
  const sources = createSources(directories)
  await writeConfig(userData, sources)
  return {
    root,
    sources,
    files: [
      { path: claude.file, text: claude.text, kind: 'claude' },
      { path: pi.file, text: pi.text, kind: 'pi' },
      { path: unknown.file, text: unknown.text, kind: 'unknown' },
      { path: codexMain.file, text: codexMain.text, kind: 'codex' },
      { path: codexArchive.file, text: codexArchive.text, kind: 'codex' }
    ],
    claudeFile: claude.file,
    claudeSessionId: claude.sessionId,
    claudeTitle: claude.sessionTitle,
    claudeMessageId: claude.messageId,
    claudeOutputTokens: 17,
    piSessionId: pi.sessionId,
    codexTitles: [codexMain.title, codexArchive.title]
  }
}

export async function createOwnerPage(scratch) {
  const preload = join(scratch, 'owner-preload.cjs')
  const page = join(scratch, 'owner.html')
  await writeFile(
    preload,
    `
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('sessionCleanerOwner', {
  open: () => ipcRenderer.invoke('session-cleaner:open'),
  invoke: async (channel, ...args) => {
    try { return { ok: true, value: await ipcRenderer.invoke(channel, ...args) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  }
})
`,
    'utf8'
  )
  await writeFile(page, '<!doctype html><html><body>Temporary owner</body></html>', 'utf8')
  return { preload, page }
}

const RESTORE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$recycle = (New-Object -ComObject Shell.Application).NameSpace(10)
$targets = ConvertFrom-Json $env:CLEANER_TEST_TARGETS
foreach ($target in $targets) {
  $directory = [IO.Path]::GetFullPath([string]$target.directory)
  $fileName = [string]$target.fileName
  $baseName = [IO.Path]::GetFileNameWithoutExtension($fileName)
  $matches = @($recycle.Items() | Where-Object {
    $_.ExtendedProperty('System.Recycle.DeletedFrom') -ieq $directory -and
    ($_.Name -ieq $fileName -or $_.Name -ieq $baseName)
  })
  if ($matches.Count -ne 1) { throw "Owned fixture not found uniquely: $directory\$fileName" }
  $matches[0].InvokeVerb('undelete')
}
`

async function restoreWithShell(files) {
  await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(RESTORE_SCRIPT, 'utf16le').toString('base64')
    ],
    {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4096,
      env: {
        ...process.env,
        CLEANER_TEST_TARGETS: JSON.stringify(
          files.map((file) => ({ directory: dirname(file.path), fileName: basename(file.path) }))
        )
      }
    }
  )
}

export async function restoreMissingFixtures(fixtures) {
  if (!fixtures) return
  const missing = []
  for (const file of fixtures.files) {
    try {
      await readFile(file.path)
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(file)
      else throw error
    }
  }
  if (!missing.length) return
  if (fixtures.deletionMode === 'permanent') {
    for (const file of missing)
      await writeFile(file.path, file.text, { encoding: 'utf8', flag: 'wx' })
    console.log(`PASS restored ${missing.length} exact owned fixture(s) after permanent deletion`)
  } else {
    await restoreWithShell(missing)
    console.log(
      `PASS Windows Shell COM restored ${missing.length} exact owned fixture(s); other recycle-bin items untouched`
    )
  }
  for (const file of missing) {
    let restored = false
    for (let attempt = 0; attempt < RESTORE_POLL_ATTEMPTS; attempt++) {
      try {
        restored = (await readFile(file.path, 'utf8')) === file.text
      } catch {
        /* 等待测试文件恢复。 */
      }
      if (restored) break
      await delay(RESTORE_POLL_INTERVAL_MS)
    }
    if (!restored) throw new Error(`测试文件恢复失败：${file.path}`)
  }
}
