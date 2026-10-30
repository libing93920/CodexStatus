/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { identifySource, discoverSources } from '../src/main/tools/session-cleaner/sources.ts'
import {
  resolveCatalogSourceSpecs,
  resolveOpenCodeDatabasePath
} from '../src/main/tools/session-cleaner/catalog-paths.ts'
import { scanPiCatalog } from '../src/main/tools/session-cleaner/catalog-pi.ts'

async function fixtureHome(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-cleaner-discovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function makeDirectory(root) {
  await mkdir(root, { recursive: true })
  return root
}

async function writeFixture(file, contents = '') {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
  return file
}

function sourceMap(sources) {
  return new Map(
    sources.map((source) => [source.kind, sources.filter((item) => item.kind === source.kind)])
  )
}

test('discovers cc-switch roots, honors path overrides, and ignores unrelated environment overrides', async (t) => {
  const home = await fixtureHome(t)
  const appData = path.join(home, 'roaming')
  const privateData = path.join(home, 'cc-switch-data')
  const xdg = path.join(home, 'xdg-data')
  const database = path.join(home, 'custom-opencode.sqlite')
  const settings = {
    codexConfigDir: '~/cc-codex',
    claudeConfigDir: '~/cc-claude',
    geminiConfigDir: '~/cc-gemini',
    grokConfigDir: '~/cc-grok',
    opencodeConfigDir: '~/cc-opencode-config',
    openclawConfigDir: '~/cc-openclaw',
    hermesConfigDir: '~/cc-hermes',
    piConfigDir: '~/cc-pi-agent',
    ompConfigDir: '~/cc-omp-agent',
    webdavSync: { password: 'never-display-this-fixture-secret' }
  }
  await writeFixture(path.join(home, '.cc-switch', 'settings.json'), JSON.stringify(settings))
  await writeFixture(
    path.join(appData, 'com.ccswitch.desktop', 'app_paths.json'),
    JSON.stringify({
      app_config_dir_override: privateData
    })
  )
  await makeDirectory(privateData)

  const directories = [
    'cc-codex/sessions',
    'cc-codex/archived_sessions',
    'cc-claude/projects',
    'cc-gemini/tmp',
    'cc-grok/sessions',
    'cc-grok/archived_sessions',
    'cc-openclaw/agents',
    'cc-hermes',
    'cc-omp-agent/sessions',
    '.gemini/antigravity-cli/brain',
    '.gemini/antigravity/brain',
    'cc-switch-data/agy/private-relay/antigravity-cli/brain'
  ]
  for (const directory of directories) await makeDirectory(path.join(home, directory))
  const piRoot = path.join(home, 'pi-flat-sessions')
  await makeDirectory(piRoot)
  await writeFixture(
    path.join(home, 'cc-pi-agent', 'settings.json'),
    `{
    // Pi accepts JSON5 comments and trailing commas.
    sessionDir: '~/pi-flat-sessions',
    apiKey: 'never-display-this-fixture-secret',
  }`
  )
  const openCodeBase = path.join(xdg, 'opencode')
  await makeDirectory(path.join(openCodeBase, 'storage', 'session'))
  await writeFixture(database)

  const env = {
    APPDATA: appData,
    XDG_DATA_HOME: xdg,
    OPENCODE_DB: database,
    CODEX_HOME: path.join(home, 'ignored-codex-home'),
    CLAUDE_CONFIG_DIR: path.join(home, 'ignored-claude-home'),
    GEMINI_CLI_HOME: path.join(home, 'ignored-gemini-home'),
    HERMES_HOME: path.join(home, 'ignored-hermes-home'),
    MINIMAX_DATA_DIR: path.join(home, 'minimax-data'),
    KIMI_CODE_HOME: path.join(home, 'kimi-data')
  }
  await makeDirectory(env.MINIMAX_DATA_DIR)
  await makeDirectory(path.join(env.KIMI_CODE_HOME, 'sessions'))

  const sources = await discoverSources({ home, env, registered: [] })
  const byKind = sourceMap(sources)
  const expected = (kind, relative) =>
    assert.ok(
      byKind.get(kind)?.some((source) => source.path === path.join(home, relative)),
      `${kind} path not discovered: ${relative}`
    )
  assert.equal(byKind.get('codex').length, 2)
  expected('codex', 'cc-codex/sessions')
  expected('codex', 'cc-codex/archived_sessions')
  expected('claude', 'cc-claude/projects')
  expected('gemini', 'cc-gemini/tmp')
  expected('openclaw', 'cc-openclaw/agents')
  expected('hermes', 'cc-hermes')
  expected('grokbuild', 'cc-grok/sessions')
  expected('grokbuild', 'cc-grok/archived_sessions')
  expected('pi', 'pi-flat-sessions')
  expected('omp', 'cc-omp-agent/sessions')
  expected('mcode', 'minimax-data')
  expected('kimi', 'kimi-data/sessions')
  assert.equal(byKind.get('agy').length, 3)
  assert.equal(byKind.get('opencode')[0].path, openCodeBase)
  assert.equal(byKind.get('opencode')[0].databasePath, database)
  assert.equal(resolveOpenCodeDatabasePath({ home, env }), database)
  assert.ok(byKind.get('opencode')[0].note.includes('SQLite'))
  assert.ok(sources.every((source) => !source.note.includes('never-display-this-fixture-secret')))
})

test('discovers and manually identifies an external OpenCode database without its base directory', async (t) => {
  const home = await fixtureHome(t)
  const xdg = path.join(home, 'xdg-data')
  const database = path.join(home, 'external', 'sessions.sqlite')
  await writeFixture(database)

  const env = { XDG_DATA_HOME: xdg, OPENCODE_DB: database }
  const discovered = await discoverSources({ home, env, registered: [] })
  const source = discovered.find((candidate) => candidate.kind === 'opencode')
  assert.ok(source)
  assert.equal(source.path, path.join(xdg, 'opencode'))
  assert.equal(source.databasePath, database)

  const keys = ['CC_SWITCH_TEST_HOME', 'XDG_DATA_HOME', 'OPENCODE_DB']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  process.env.CC_SWITCH_TEST_HOME = home
  process.env.XDG_DATA_HOME = xdg
  process.env.OPENCODE_DB = database
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const manual = await identifySource(database)
  assert.equal(manual.kind, 'opencode')
  assert.equal(manual.path, database)
  assert.equal(manual.databasePath, database)
  assert.equal(manual.origin, 'manual')
})

test('CC_SWITCH_TEST_HOME comes only from the selected environment object', async (t) => {
  const homeOverride = await fixtureHome(t)
  const previous = process.env.CC_SWITCH_TEST_HOME
  process.env.CC_SWITCH_TEST_HOME = homeOverride
  t.after(() => {
    if (previous === undefined) delete process.env.CC_SWITCH_TEST_HOME
    else process.env.CC_SWITCH_TEST_HOME = previous
  })

  const specs = await resolveCatalogSourceSpecs({ env: {} })
  assert.equal(
    specs.find((source) => source.kind === 'codex').path,
    path.join(os.homedir(), '.codex', 'sessions')
  )
})

test('OMP follows the active profile XDG data root on Linux and keeps the project layout', async (t) => {
  const home = await fixtureHome(t)
  const xdg = path.join(home, 'xdg-data')
  const sessions = path.join(xdg, 'omp', 'profiles', 'work', 'sessions')
  await makeDirectory(sessions)

  const specs = await resolveCatalogSourceSpecs({
    home,
    platform: 'linux',
    env: { OMP_PROFILE: 'work', XDG_DATA_HOME: xdg }
  })
  const omp = specs.find((source) => source.kind === 'omp')
  assert.equal(omp.path, sessions)
  assert.equal(omp.layout, 'projects')
})

test('a relative Pi sessionDir stays visible as unavailable and never scans the default root', async (t) => {
  const home = await fixtureHome(t)
  const defaultRoot = path.join(home, '.pi', 'agent', 'sessions')
  await writeFixture(
    path.join(home, '.pi', 'agent', 'settings.json'),
    `{
    // This value needs the launching project cwd, so cc-switch cannot enumerate it globally.
    sessionDir: 'relative/project-sessions',
  }`
  )
  await writeFixture(
    path.join(defaultRoot, 'project', 'must-not-appear.jsonl'),
    JSON.stringify({
      id: 'default-session',
      cwd: path.join(home, 'project'),
      timestamp: '2026-10-28T00:00:00.000Z'
    })
  )

  const sources = await discoverSources({ home, env: {}, registered: [] })
  const pi = sources.find((source) => source.kind === 'pi')
  assert.ok(pi)
  assert.equal(pi.unavailable, true)
  assert.match(pi.note, /无法全局枚举/)
  assert.match(pi.note, /不会退回默认目录/)
  const result = await scanPiCatalog(pi)
  assert.deepEqual(result.sessions, [])
  assert.ok(result.issues.some((issue) => issue.message === pi.note))
})

test('refresh replaces stale auto roots and fills missing Pi layout while preserving manual sources', async (t) => {
  const home = await fixtureHome(t)
  const settings = { codexConfigDir: '~/new-codex' }
  await writeFixture(path.join(home, '.cc-switch', 'settings.json'), JSON.stringify(settings))
  const newCodexRoot = path.join(home, 'new-codex', 'sessions')
  const oldCodexRoot = path.join(home, '.codex', 'sessions')
  const piRoot = path.join(home, '.pi', 'agent', 'sessions')
  const openCodeBase = path.join(home, '.local', 'share', 'opencode')
  await Promise.all([
    makeDirectory(newCodexRoot),
    makeDirectory(oldCodexRoot),
    makeDirectory(piRoot),
    makeDirectory(openCodeBase),
    writeFixture(path.join(openCodeBase, 'opencode.db'))
  ])
  const manual = {
    id: 'manual-source',
    kind: 'unknown',
    name: '手动来源',
    path: path.join(home, 'manual'),
    origin: 'manual',
    capability: 'files',
    note: '手动目录'
  }
  await makeDirectory(manual.path)
  const registered = [
    { ...manual },
    {
      id: 'old-codex',
      kind: 'codex',
      name: 'Codex',
      path: oldCodexRoot,
      origin: 'discovered',
      capability: 'sessions',
      note: 'old'
    },
    {
      id: 'old-pi',
      kind: 'pi',
      name: 'Pi',
      path: piRoot,
      origin: 'discovered',
      capability: 'sessions',
      note: 'old'
    },
    {
      id: 'old-opencode',
      kind: 'opencode',
      name: 'OpenCode',
      path: path.join(openCodeBase, 'opencode.db'),
      origin: 'discovered',
      capability: 'sessions',
      note: 'old'
    }
  ]

  const sources = await discoverSources({ home, env: {}, registered })
  assert.ok(sources.some((source) => source.id === manual.id))
  assert.ok(!sources.some((source) => source.id === 'old-codex' || source.path === oldCodexRoot))
  assert.ok(
    !sources.some((source) => source.id === 'old-opencode' || source.path.endsWith('opencode.db'))
  )
  assert.equal(sources.find((source) => source.kind === 'pi')?.layout, 'projects')
  assert.equal(sources.find((source) => source.kind === 'opencode')?.path, openCodeBase)
})

test('manual identification uses the configured Pi root and its active flat layout', async (t) => {
  const home = await fixtureHome(t)
  const piRoot = path.join(home, 'configured-flat-sessions')
  await makeDirectory(piRoot)
  await writeFixture(
    path.join(home, '.cc-switch', 'settings.json'),
    JSON.stringify({ piConfigDir: '~/pi-agent' })
  )
  await writeFixture(
    path.join(home, 'pi-agent', 'settings.json'),
    JSON.stringify({ sessionDir: piRoot })
  )
  const previous = process.env.CC_SWITCH_TEST_HOME
  process.env.CC_SWITCH_TEST_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.CC_SWITCH_TEST_HOME
    else process.env.CC_SWITCH_TEST_HOME = previous
  })

  const source = await identifySource(piRoot)
  assert.equal(source.kind, 'pi')
  assert.equal(source.path, piRoot)
  assert.equal(source.layout, 'flat')
  assert.equal(source.origin, 'manual')
})

test('Windows AgY 私有目录遵守旧HOME数据库分支，测试home明确跳过', async (t) => {
  const home = await fixtureHome(t)
  const oldHome = path.join(home, 'legacy-home')
  const profile = path.join(oldHome, '.cc-switch', 'agy', 'provider', 'antigravity-cli', 'brain')
  await makeDirectory(profile)
  await writeFixture(path.join(oldHome, '.cc-switch', 'cc-switch.db'))
  const env = { HOME: oldHome }
  const legacy = await resolveCatalogSourceSpecs({ home, env, platform: 'win32' })
  assert.ok(legacy.some((source) => source.kind === 'agy' && source.path === profile))
  const isolated = await resolveCatalogSourceSpecs({
    home,
    env: { ...env, CC_SWITCH_TEST_HOME: home },
    platform: 'win32'
  })
  assert.ok(!isolated.some((source) => source.path === profile))
  await writeFixture(path.join(home, '.cc-switch', 'cc-switch.db'))
  const normal = await resolveCatalogSourceSpecs({ home, env, platform: 'win32' })
  assert.ok(!normal.some((source) => source.path === profile))
})
