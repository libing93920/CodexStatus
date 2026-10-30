/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanGeminiCatalog } from '../src/main/tools/session-cleaner/catalog-gemini.ts'

const temporaryRoots = []

after(async () => {
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

test('discovers arbitrary chat filenames, prefers JSONL, and keeps project and title metadata', async () => {
  const root = await tempDirectory('discovery')
  const chats = path.join(root, 'project-a', 'chats')
  await fs.mkdir(chats, { recursive: true })
  await fs.writeFile(path.join(root, 'project-a', '.project_root'), 'C:\\work\\alpha\r\n')

  await writeJsonl(path.join(chats, 'arbitrary-name.jsonl'), [
    {
      sessionId: 'jsonl-wins',
      startTime: '2025-06-01T12:34:56.789+02:00',
      lastUpdated: 1_750_000_000_000,
      messages: [
        { type: 'user', content: '  /model switch  ' },
        { type: 'user', content: '?help' },
        { type: 'user', content: '\u0085 /prefixed-command' },
        { type: 'user', content: '  <session_context>injected' },
        { type: 'user', content: ' <hook_context>injected' },
        { type: 'user', content: [{ text: 'Feature A' }, { type: 'image' }, { text: 'Feature B' }] }
      ]
    }
  ])
  await fs.writeFile(
    path.join(chats, 'arbitrary-name.json'),
    JSON.stringify({ sessionId: 'legacy-duplicate', messages: [] })
  )
  await fs.writeFile(
    path.join(chats, 'legacy-history.json'),
    JSON.stringify({ sessionId: 'legacy-only' })
  )
  await fs.writeFile(
    path.join(chats, 'ignored.txt'),
    JSON.stringify({ sessionId: 'wrong-extension' })
  )
  await fs.mkdir(path.join(chats, 'nested'))
  await fs.writeFile(
    path.join(chats, 'nested', 'nested.jsonl'),
    JSON.stringify({ sessionId: 'nested-file' })
  )
  await fs.writeFile(path.join(chats, 'invalid.json'), '{broken')
  await fs.writeFile(
    path.join(chats, 'unicode-trim.json'),
    JSON.stringify({
      sessionId: 'unicode-trim',
      messages: [{ type: 'user', content: '\uFEFFpreserved' }]
    })
  )

  const result = await scanGeminiCatalog(source(root))
  const sessions = new Map(result.sessions.map((session) => [session.sessionId, session]))
  assert.deepEqual(new Set(sessions.keys()), new Set(['jsonl-wins', 'legacy-only', 'unicode-trim']))
  assert.equal(sessions.get('jsonl-wins').path, path.join(chats, 'arbitrary-name.jsonl'))
  assert.equal(sessions.get('jsonl-wins').project, 'C:\\work\\alpha\r\n')
  assert.equal(sessions.get('jsonl-wins').title, 'Feature A\nFeature B')
  assert.equal(sessions.get('jsonl-wins').summary, 'Feature A\nFeature B')
  assert.equal(sessions.get('jsonl-wins').createdAt, Date.parse('2025-06-01T12:34:56.789+02:00'))
  assert.equal(sessions.get('jsonl-wins').modifiedAt, 1_750_000_000_000)
  assert.equal(sessions.get('unicode-trim').title, '\uFEFFpreserved')
  assert.deepEqual(result.issues, [])
})

test('replays message upserts, $set reset, and known or unknown rewind markers', async () => {
  const root = await tempDirectory('replay')
  const chats = path.join(root, 'project', 'chats')
  await fs.mkdir(chats, { recursive: true })

  await writeJsonl(path.join(chats, 'duplicate.jsonl'), [
    { sessionId: 'duplicate' },
    { id: 'first', type: 'user', content: '/initially ignored' },
    { id: 'second', type: 'user', content: 'second in order' },
    { id: 'first', type: 'user', content: 'first now visible' }
  ])
  await writeJsonl(path.join(chats, 'rewind.jsonl'), [
    { sessionId: 'rewind', startTime: 1_700_000_000 },
    { id: 'old', type: 'user', content: 'removed by reset' },
    {
      $set: {
        lastUpdated: '2025-06-01T12:34:56Z',
        messages: [
          { id: 'checkpoint', type: 'user', content: 'checkpoint title' },
          { id: 'target', type: 'user', content: 'removed with target' },
          { id: 'later', type: 'user', content: 'removed after target' }
        ]
      }
    },
    { $rewindTo: 'target' }
  ])
  await writeJsonl(path.join(chats, 'unknown-rewind.jsonl'), [
    { sessionId: 'unknown-rewind' },
    { id: 'visible', type: 'user', content: 'removed by unknown rewind' },
    { $rewindTo: 'missing-id' }
  ])

  const result = await scanGeminiCatalog(source(root))
  const sessions = new Map(result.sessions.map((session) => [session.sessionId, session]))
  assert.equal(sessions.get('duplicate').title, 'first now visible')
  assert.equal(sessions.get('rewind').title, 'checkpoint title')
  assert.equal(sessions.get('rewind').createdAt, 1_700_000_000_000)
  assert.equal(sessions.get('rewind').modifiedAt, Date.parse('2025-06-01T12:34:56Z'))
  assert.equal(sessions.has('unknown-rewind'), true)
  assert.equal(sessions.get('unknown-rewind').title, undefined)
})

test('uses strict RFC3339 timestamps and truncates titles by Unicode characters at 160', async () => {
  const root = await tempDirectory('metadata')
  const chats = path.join(root, 'project', 'chats')
  await fs.mkdir(chats, { recursive: true })
  const character = String.fromCodePoint(0x1f642)
  const longTitle = character.repeat(161)
  await writeJsonl(path.join(chats, 'long-title.jsonl'), [
    {
      sessionId: 'long-title',
      startTime: '2024-02-30T00:00:00Z',
      lastUpdated: '2026-01-01T00:00:00',
      messages: [{ type: 'user', content: longTitle }]
    }
  ])
  await writeJsonl(path.join(chats, 'fractional-time.jsonl'), [
    { sessionId: 'fractional-time', startTime: 1_700_000_000.125 }
  ])
  await writeJsonl(path.join(chats, 'invalid-set.jsonl'), [
    {
      $set: 'ignored',
      sessionId: 'invalid-set',
      messages: [{ id: 'message', type: 'user', content: 'metadata record' }]
    }
  ])

  const result = await scanGeminiCatalog(source(root))
  const sessions = new Map(result.sessions.map((item) => [item.sessionId, item]))
  const session = sessions.get('long-title')
  assert.equal(Array.from(session.title).length, 163)
  assert.equal(session.title, `${character.repeat(160)}...`)
  assert.equal(session.createdAt, undefined)
  assert.equal(session.modifiedAt, undefined)
  assert.equal(sessions.get('fractional-time').createdAt, 1_700_000_000_000)
  assert.equal(sessions.get('invalid-set').title, 'metadata record')
})

test('does not follow Gemini root, project, chats, or session-file links', async (context) => {
  const temporary = await tempDirectory('links')
  const root = path.join(temporary, 'gemini-root')
  const outside = path.join(temporary, 'outside')
  const projectTarget = path.join(outside, 'linked-project')
  const chatsTarget = path.join(outside, 'linked-chats')
  const fileTarget = path.join(outside, 'linked-file.jsonl')
  const fileDirectoryTarget = path.join(outside, 'file-target-directory')
  const projectLink = path.join(root, 'project-link')
  const chatsLink = path.join(root, 'chats-project', 'chats')
  const fileLink = path.join(root, 'file-project', 'chats', 'linked-file.jsonl')
  const rootLink = path.join(temporary, 'root-link')
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

  await fs.mkdir(root, { recursive: true })
  await writeJsonl(path.join(root, 'regular-project', 'chats', 'safe.jsonl'), [
    { sessionId: 'safe' }
  ])
  await writeJsonl(path.join(projectTarget, 'chats', 'project-link.jsonl'), [
    { sessionId: 'project-link' }
  ])
  await writeJsonl(path.join(chatsTarget, 'chats-link.jsonl'), [{ sessionId: 'chats-link' }])
  await writeJsonl(fileTarget, [{ sessionId: 'file-link' }])
  await writeJsonl(path.join(fileDirectoryTarget, 'inside.jsonl'), [
    { sessionId: 'directory-link' }
  ])
  await fs.mkdir(path.dirname(chatsLink), { recursive: true })
  await fs.mkdir(path.dirname(fileLink), { recursive: true })

  try {
    await fs.symlink(projectTarget, projectLink, directoryLinkType)
    await fs.symlink(chatsTarget, chatsLink, directoryLinkType)
    await fs.symlink(root, rootLink, directoryLinkType)
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      context.skip(`directory links unavailable: ${error.code}`)
      return
    }
    throw error
  }

  let fileLinkCreated = true
  try {
    await fs.symlink(fileTarget, fileLink, 'file')
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error
    try {
      await fs.symlink(fileDirectoryTarget, fileLink, directoryLinkType)
    } catch (directoryLinkError) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(directoryLinkError?.code))
        throw directoryLinkError
      fileLinkCreated = false
    }
  }

  const rootResult = await scanGeminiCatalog(source(rootLink))
  assert.deepEqual(rootResult.sessions, [])
  assert.ok(rootResult.issues.some((issue) => issue.path === rootLink))

  const result = await scanGeminiCatalog(source(root))
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ['safe']
  )
  assert.ok(result.issues.some((issue) => issue.path === projectLink))
  assert.ok(result.issues.some((issue) => issue.path === chatsLink))
  if (fileLinkCreated) assert.ok(result.issues.some((issue) => issue.path === fileLink))
})

test('honors an already-aborted scan signal', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(scanGeminiCatalog(source('unused'), controller.signal), {
    name: 'AbortError'
  })
})

function source(root) {
  return {
    id: 'gemini-fixture',
    kind: 'gemini',
    name: 'Gemini',
    path: root,
    origin: 'discovered',
    capability: 'sessions',
    note: 'fixture'
  }
}

async function tempDirectory(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `session-cleaner-gemini-${name}-`))
  temporaryRoots.push(root)
  return root
}

async function writeJsonl(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}
