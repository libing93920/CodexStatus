/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { scanCodexCatalog } from '../src/main/tools/session-cleaner/catalog-codex.ts'
import { scanClaudeCatalog } from '../src/main/tools/session-cleaner/catalog-claude.ts'
import { scanOpenCodeCatalog } from '../src/main/tools/session-cleaner/catalog-opencode.ts'
import { scanPiCatalog } from '../src/main/tools/session-cleaner/catalog-pi.ts'
import { time, trimText } from '../src/main/tools/session-cleaner/catalog-io.ts'
import { scanSources } from '../src/main/tools/session-cleaner/scanner.ts'
import { DEFAULT_CLEANER_SETTINGS } from '../src/shared/session-cleaner.ts'

const ID = '12345678-1234-4234-8234-123456789abc'
const STAMP = '2026-01-02T03:04:05Z'

async function fixture(t, kind, layout) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cleaner-catalog-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return {
    id: kind,
    kind,
    path: root,
    name: kind,
    capability: 'sessions',
    origin: 'manual',
    note: '',
    layout
  }
}

async function jsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
}

function codexEntries(id = ID, source) {
  return [
    { type: 'session_meta', timestamp: STAMP, payload: { id, cwd: '/work/project', source } },
    {
      type: 'response_item',
      timestamp: STAMP,
      payload: { type: 'message', role: 'user', content: '# AGENTS.md\ninjected' }
    },
    {
      type: 'response_item',
      timestamp: STAMP,
      payload: { type: 'message', role: 'user', content: '真实请求' }
    }
  ]
}

test('Codex 读取索引与状态标题，排除子代理并按普通/压缩同名去重', async (t) => {
  const source = await fixture(t, 'codex')
  const home = source.path
  source.path = path.join(home, 'sessions')
  const plain = path.join(source.path, `rollout-${ID}.jsonl`)
  await jsonl(plain, codexEntries())
  await fs.writeFile(`${plain}.zst`, zstdCompressSync(await fs.readFile(plain)))
  await jsonl(
    path.join(source.path, 'child.jsonl'),
    codexEntries('child', { subagent: { parent_thread_id: ID } })
  )
  await fs.writeFile(
    path.join(home, 'session_index.jsonl'),
    JSON.stringify({ id: ID, thread_name: '索引标题' }) + '\n'
  )
  const database = new DatabaseSync(path.join(home, 'state_5.sqlite'))
  database.exec('CREATE TABLE threads(id TEXT,title TEXT,first_user_message TEXT)')
  database.prepare('INSERT INTO threads VALUES(?,?,?)').run(ID, '状态标题', '最初请求')
  database.close()
  const result = await scanCodexCatalog(source)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].title, '状态标题')
  assert.equal(result.sessions[0].sessionId, ID)
  assert.equal(result.sessions[0].path, plain)
  assert.equal(result.sessions[0].createdAt, Date.parse(STAMP))
  await fs.unlink(plain)
  const compressed = await scanCodexCatalog(source)
  assert.equal(compressed.sessions.length, 1)
  assert.equal(compressed.sessions[0].path, `${plain}.zst`)
  assert.equal(compressed.sessions[0].summary, undefined)
})

test('Codex sqlite_home 按真实 TOML 语法解析且配置优先于环境变量', async (t) => {
  const source = await fixture(t, 'codex')
  const home = source.path
  source.path = path.join(home, 'sessions')
  await jsonl(path.join(source.path, 'session.jsonl'), codexEntries())
  const sqliteHome = path.join(home, 'state folder')
  await fs.mkdir(sqliteHome)
  await fs.writeFile(path.join(home, 'config.toml'), `sqlite_home = '${sqliteHome}' # comment\n`)
  const database = new DatabaseSync(path.join(sqliteHome, 'state_5.sqlite'))
  database.exec('CREATE TABLE threads(id TEXT,title TEXT,first_user_message TEXT)')
  database.prepare('INSERT INTO threads VALUES(?,?,?)').run(ID, '指定库标题', 'different')
  database.close()
  assert.equal((await scanCodexCatalog(source)).sessions[0].title, '指定库标题')
})

test('Claude 使用尾部改名、最后 relocated cwd，排除 agent 和 journal', async (t) => {
  const source = await fixture(t, 'claude')
  const entries = [
    {
      type: 'user',
      sessionId: 'main',
      cwd: 'C:\\old',
      timestamp: STAMP,
      message: { role: 'user', content: '<local-command-stdout>noise' }
    },
    {
      type: 'user',
      sessionId: 'main',
      timestamp: STAMP,
      message: { content: [{ type: 'text', text: '实际用户请求' }] }
    },
    ...Array.from({ length: 70 }, () => ({ type: 'assistant', message: { content: '内容' } })),
    { type: 'custom-title', customTitle: '旧名称' },
    { type: 'relocated', relocatedCwd: 'C:\\new' },
    { type: 'custom-title', customTitle: '最新名称' }
  ]
  await jsonl(path.join(source.path, 'main.jsonl'), entries)
  await jsonl(path.join(source.path, 'agent-worker.jsonl'), entries)
  await jsonl(path.join(source.path, 'journal.jsonl'), entries)
  const result = await scanClaudeCatalog(source)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].title, '最新名称')
  assert.equal(result.sessions[0].project, 'C:\\new')
})

test('OpenCode 超过256MB的库仍读取V2和迁移后V1，再合并旧JSON', async (t) => {
  const source = await fixture(t, 'opencode')
  const file = path.join(source.path, 'opencode.db')
  const database = new DatabaseSync(file)
  database.exec(`CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_v2(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE session_message(session_id TEXT,time_updated INTEGER);
    CREATE TABLE kv(key TEXT,time_created INTEGER,time_updated INTEGER);
    INSERT INTO kv VALUES('migration.v1-v2',1000,1000);
    INSERT INTO session_v2 VALUES('ses_v2','新版','/v2',1000,2000);
    INSERT INTO session_message VALUES('ses_v2',3000);
    INSERT INTO session VALUES('ses_v2','重复旧版','/duplicate',1000,4000);
    INSERT INTO session VALUES('ses_new','迁移后','/new',1000,2000);
    INSERT INTO session VALUES('ses_stale','迁移前','/old',500,500);`)
  database.close()
  await fs.truncate(file, 257 * 1024 ** 2)
  const jsonRoot = path.join(source.path, 'storage', 'session', 'project')
  await fs.mkdir(jsonRoot, { recursive: true })
  await fs.writeFile(
    path.join(jsonRoot, 'a.json'),
    JSON.stringify({ id: 'ses_v2', title: 'JSON重复' })
  )
  await fs.writeFile(
    path.join(jsonRoot, 'b.json'),
    JSON.stringify({
      id: 'ses_json',
      title: '仅JSON',
      directory: '/json',
      time: { created: 1, updated: 2 }
    })
  )
  const result = await scanOpenCodeCatalog(source)
  assert.equal(result.issues.length, 0)
  assert.deepEqual(
    new Set(result.sessions.map((item) => item.sessionId)),
    new Set(['ses_v2', 'ses_new', 'ses_json'])
  )
  assert.equal(result.sessions.find((item) => item.sessionId === 'ses_v2').title, '新版')
  assert.equal(result.sessions.find((item) => item.sessionId === 'ses_v2').modifiedAt, 3000)
})

test('Pi 严格区分项目目录/平铺布局，名称取最后 session_info，支持未来版本只读识别', async (t) => {
  const source = await fixture(t, 'pi', 'projects')
  const entries = [
    { type: 'session', version: 4, id: 'pi-main', cwd: '/work/pi', timestamp: STAMP },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      message: { role: 'user', content: '第一条请求', timestamp: STAMP }
    },
    { type: 'session_info', name: '自定义名称' }
  ]
  await jsonl(path.join(source.path, 'project', 'main.jsonl'), entries)
  await jsonl(path.join(source.path, 'flat.jsonl'), entries)
  await jsonl(path.join(source.path, 'project', 'main', 'child.jsonl'), entries)
  const result = await scanPiCatalog(source)
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0].title, '自定义名称')
  assert.equal(result.sessions[0].modifiedAt, Date.parse(STAMP))
  const flat = await scanPiCatalog({ ...source, layout: 'flat' })
  assert.equal(flat.sessions.length, 1)
  assert.equal(path.basename(flat.sessions[0].path), 'flat.jsonl')
})

test('Codex IDE 标题行必须有合法分隔符，且连续分隔符按上游剥离', async (t) => {
  const source = await fixture(t, 'codex')
  const entries = codexEntries()
  entries[2].payload.content = '# Context from my IDE setup:\n## My request for Codex Fix the bug'
  await jsonl(path.join(source.path, 'invalid-heading.jsonl'), entries)
  entries[0].payload.id = 'other'
  entries[2].payload.content =
    '# Context from my IDE setup:\n## My request for Codex: -- — 实际修复'
  await jsonl(path.join(source.path, 'valid-heading.jsonl'), entries)
  const result = await scanCodexCatalog(source)
  assert.equal(result.sessions.find((item) => item.sessionId === ID).title, 'project')
  assert.equal(result.sessions.find((item) => item.sessionId === 'other').title, '实际修复')
})

test('OMP 空前置标题槽清除会话头名称，随后以真实请求作为名称', async (t) => {
  const source = await fixture(t, 'omp', 'flat')
  await jsonl(path.join(source.path, 'main.jsonl'), [
    { type: 'title' },
    { type: 'session', version: 3, id: 'main', title: '不应采用的旧名称', cwd: '/work' },
    { type: 'message', id: 'request', message: { role: 'user', content: '实际请求' } }
  ])
  assert.equal((await scanPiCatalog(source, undefined, 'omp')).sessions[0].title, '实际请求')
})

test('公共时间和空白解析与上游保持一致', () => {
  assert.equal(time('2024-02-31T00:00:00Z'), undefined)
  assert.equal(time('2025-01-01T12:00:00'), undefined)
  assert.equal(time('2025-01-01t12:00:00z'), Date.parse('2025-01-01T12:00:00Z'))
  assert.equal(time('2025-01-01 12:00:00Z'), Date.parse('2025-01-01T12:00:00Z'))
  assert.equal(time(1_700_000_000.125), 1_700_000_000_000)
  assert.equal(trimText('\u0085名称\u0085'), '名称')
  assert.equal(trimText('\uFEFF名称'), '\uFEFF名称')
})

test('OpenCode base 不存在时仍查询外置数据库并只计一次数据库占用', async (t) => {
  const source = await fixture(t, 'opencode')
  const databasePath = path.join(source.path, 'external.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER);
    INSERT INTO session VALUES('ses_external','外置库标题','/external',100,200);`)
  database.close()
  source.path = path.join(source.path, 'missing-base')
  source.databasePath = databasePath
  const result = await scanSources({
    sources: [source],
    settings: DEFAULT_CLEANER_SETTINGS,
    protectedIds: []
  })
  assert.equal(result.issues.length, 0)
  const sessions = result.items.filter((item) => item.category === 'sessions')
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].title, '外置库标题')
  assert.equal(sessions[0].bytes, 0)
  assert.equal(
    result.items.reduce((sum, item) => sum + item.bytes, 0),
    (await fs.stat(databasePath)).size
  )
  assert.ok(result.items.every((item) => item.status !== 'candidate'))
})
