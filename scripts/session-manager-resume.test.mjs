/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildResumeTarget } from '../src/main/tools/session-cleaner/resume-target.ts'

const MALICIOUS_ID = "session ' $() & echo hacked; `evil"

function managedSession(providerId, sessionId, sourcePath, options = {}) {
  return {
    providerId,
    sourceId: 'source-1',
    sessionId,
    sourcePath,
    modelIds: [],
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    resumeCommand: options.resumeCommand ?? `untrusted ${providerId} resume text`,
    capabilities: { read: true, delete: true, export: true, resume: true },
    storage: { kind: 'file', fileBytes: 0, sharedBytes: 0, complete: true },
    resourceIds: [],
    revision: 'fixture-revision'
  }
}

function cleanerSource(kind, sourcePath, options = {}) {
  return {
    id: 'source-1',
    kind,
    name: kind,
    path: sourcePath,
    origin: 'discovered',
    capability: 'sessions',
    note: '',
    ...options
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-status-resume-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function makeFile(target) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, 'temporary fixture')
  return target
}

async function makeDirectory(target) {
  await mkdir(target, { recursive: true })
  return target
}

test('Codex, Claude and OpenCode use the selected source configuration', async (t) => {
  const temp = await temporaryDirectory(t)
  const codexHome = path.join(temp, 'codex-home')
  const codexSessions = await makeDirectory(path.join(codexHome, 'sessions'))
  const codexFile = await makeFile(path.join(codexSessions, 'rollout.jsonl'))
  const codexTarget = buildResumeTarget({
    session: managedSession('codex', MALICIOUS_ID, codexFile, {
      resumeCommand: `powershell.exe -Command ${MALICIOUS_ID}`
    }),
    source: cleanerSource('codex', codexSessions)
  })
  assert.equal(codexTarget.executable, 'codex')
  assert.deepEqual(codexTarget.args, ['resume', MALICIOUS_ID])
  assert.equal(codexTarget.env.CODEX_HOME, codexHome)

  const claudeHome = path.join(temp, 'claude-home')
  const claudeProjects = await makeDirectory(path.join(claudeHome, 'projects'))
  const claudeFile = await makeFile(path.join(claudeProjects, 'project', 'session.jsonl'))
  const claudeTarget = buildResumeTarget({
    session: managedSession('claude', 'claude-id', claudeFile),
    source: cleanerSource('claude', claudeProjects)
  })
  assert.equal(claudeTarget.executable, 'claude')
  assert.deepEqual(claudeTarget.args, ['--resume', 'claude-id'])
  assert.equal(claudeTarget.env.CLAUDE_CONFIG_DIR, claudeHome)

  const openCodeRoot = await makeDirectory(path.join(temp, "xdg '$ `data", 'opencode'))
  const databasePath = await makeFile(path.join(openCodeRoot, 'opencode.db'))
  const openCodeId = 'ses_open-code'
  const openCodeTarget = buildResumeTarget({
    session: managedSession('opencode', openCodeId, `sqlite:${databasePath}:${openCodeId}`),
    source: cleanerSource('opencode', openCodeRoot, { databasePath })
  })
  assert.equal(openCodeTarget.executable, 'opencode')
  assert.deepEqual(openCodeTarget.args, ['-s', openCodeId])
  assert.equal(openCodeTarget.env.OPENCODE_DB, databasePath)
  assert.equal(openCodeTarget.env.XDG_DATA_HOME, path.dirname(openCodeRoot))
})

test('Pi, OMP, MCode and Kimi preserve source paths and environment values', async (t) => {
  const temp = await temporaryDirectory(t)
  const piRoot = await makeDirectory(path.join(temp, "custom '$ `source"))
  const piFile = await makeFile(path.join(piRoot, "session '$ `id.jsonl"))
  const piTarget = buildResumeTarget({
    session: managedSession('pi', 'pi-id', piFile),
    source: cleanerSource('pi', piRoot)
  })
  assert.equal(piTarget.executable, 'pi')
  assert.deepEqual(piTarget.args, ['--session', piFile])
  assert.equal(piTarget.args[1], piFile)

  const agentRoot = path.join(temp, '.omp', 'profiles', 'team-one', 'agent')
  const ompSessions = await makeDirectory(path.join(agentRoot, 'sessions'))
  const ompFile = await makeFile(path.join(ompSessions, 'omp-session.jsonl'))
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_CODING_AGENT_DIR
  try {
    const ompTarget = buildResumeTarget({
      session: managedSession('omp', 'omp-id', ompFile),
      source: cleanerSource('omp', ompSessions)
    })
    assert.equal(ompTarget.executable, 'omp')
    assert.deepEqual(ompTarget.args, ['--resume', ompFile])
    assert.equal(ompTarget.env.OMP_PROFILE, 'team-one')
    assert.equal(ompTarget.env.PI_PROFILE, 'team-one')
    assert.equal(ompTarget.env.PI_CODING_AGENT_DIR, agentRoot)
    assert.equal(ompTarget.env.PI_CODING_AGENT_SESSION_DIR, ompSessions)
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  }

  const mcodeData = await makeDirectory(path.join(temp, "minimax '$ `data"))
  const mcodeTarget = buildResumeTarget({
    session: managedSession('mcode', 'session_1', 'mcode:session_1'),
    source: cleanerSource('mcode', mcodeData)
  })
  assert.equal(mcodeTarget.executable, 'mcode')
  assert.deepEqual(mcodeTarget.args, ['--session', 'session_1'])
  assert.equal(mcodeTarget.env.MINIMAX_DATA_DIR, mcodeData)

  const kimiHome = await makeDirectory(path.join(temp, '.kimi-code'))
  const kimiSessions = await makeDirectory(path.join(kimiHome, 'sessions'))
  const kimiFile = await makeFile(path.join(kimiSessions, 'kimi-id.jsonl'))
  const kimiTarget = buildResumeTarget({
    session: managedSession('kimi', 'kimi-id', kimiFile),
    source: cleanerSource('kimi', kimiSessions)
  })
  assert.equal(kimiTarget.executable, 'kimi')
  assert.deepEqual(kimiTarget.args, ['--session', 'kimi-id'])
  assert.equal(kimiTarget.env.KIMI_CODE_HOME, kimiHome)
})

test('Gemini, Grok and normal AGY use upstream resume arguments', async (t) => {
  const temp = await temporaryDirectory(t)
  const geminiRoot = await makeDirectory(path.join(temp, '.gemini', 'tmp'))
  const geminiFile = await makeFile(path.join(geminiRoot, 'session.json'))
  const geminiTarget = buildResumeTarget({
    session: managedSession('gemini', 'gemini-id', geminiFile),
    source: cleanerSource('gemini', geminiRoot)
  })
  assert.equal(geminiTarget.executable, 'gemini')
  assert.deepEqual(geminiTarget.args, ['--resume', 'gemini-id'])

  const grokRoot = await makeDirectory(path.join(temp, '.grok', 'sessions'))
  const grokFile = await makeFile(path.join(grokRoot, 'session.jsonl'))
  const grokTarget = buildResumeTarget({
    session: managedSession('grokbuild', 'grok-id', grokFile),
    source: cleanerSource('grokbuild', grokRoot)
  })
  assert.equal(grokTarget.executable, 'grok')
  assert.deepEqual(grokTarget.args, ['--resume', 'grok-id'])

  const agyRoot = await makeDirectory(path.join(temp, '.gemini', 'antigravity-cli', 'brain'))
  const agySession = await makeDirectory(path.join(agyRoot, 'conversation'))
  const agyTarget = buildResumeTarget({
    session: managedSession('agy', 'agy-id', agySession),
    source: cleanerSource('agy', agyRoot)
  })
  assert.equal(agyTarget.executable, 'agy')
  assert.deepEqual(agyTarget.args, ['--conversation=agy-id'])
})

test('rejects unsupported providers, key profiles and missing directories', async (t) => {
  const temp = await temporaryDirectory(t)
  const missing = path.join(temp, 'missing', 'sessions')
  assert.throws(
    () =>
      buildResumeTarget({
        session: managedSession('codex', 'id', path.join(missing, 'id.jsonl')),
        source: cleanerSource('codex', missing)
      }),
    /不存在或不可访问/
  )

  const hermes = managedSession('hermes', 'hermes-id', 'sqlite:hermes.db:hermes-id')
  hermes.capabilities.resume = false
  hermes.resumeCommand = undefined
  assert.throws(
    () => buildResumeTarget({ session: hermes, source: cleanerSource('hermes', temp) }),
    /Hermes 上游未提供/
  )

  const openclaw = managedSession('openclaw', 'openclaw-id', 'session.jsonl')
  openclaw.capabilities.resume = false
  openclaw.resumeCommand = undefined
  assert.throws(
    () => buildResumeTarget({ session: openclaw, source: cleanerSource('openclaw', temp) }),
    /网关管理/
  )

  const profileRoot = await makeDirectory(
    path.join(temp, '.cc-switch', 'agy', 'key-profile', 'antigravity-cli', 'brain')
  )
  const conversationPath = await makeDirectory(path.join(profileRoot, 'conversation'))
  assert.throws(
    () =>
      buildResumeTarget({
        session: managedSession('agy', 'agy-id', conversationPath),
        source: cleanerSource('agy', profileRoot)
      }),
    /key profile 依赖账号配置/
  )

  const codexSessions = await makeDirectory(path.join(temp, 'codex', 'sessions'))
  const codexFile = await makeFile(path.join(codexSessions, 'id.jsonl'))
  assert.throws(
    () =>
      buildResumeTarget({
        session: managedSession('codex', 'id', codexFile, { projectDir: path.join(temp, 'gone') }),
        source: cleanerSource('codex', codexSessions)
      }),
    /项目目录不存在或不可访问/
  )
})

test('rejects a foreign source path and mismatched OpenCode database', async (t) => {
  const temp = await temporaryDirectory(t)
  const piRoot = await makeDirectory(path.join(temp, 'pi'))
  const piFile = await makeFile(path.join(piRoot, 'session.jsonl'))
  const piSession = managedSession('pi', 'pi-id', piFile)
  assert.throws(
    () =>
      buildResumeTarget({
        session: piSession,
        source: cleanerSource('pi', piRoot, { id: 'other-source' })
      }),
    /会话与来源不匹配/
  )

  const openCodeRoot = await makeDirectory(path.join(temp, 'opencode'))
  const databasePath = await makeFile(path.join(openCodeRoot, 'opencode.db'))
  const openCodeSession = managedSession(
    'opencode',
    'ses_expected',
    `sqlite:${databasePath}:ses_expected`
  )
  assert.throws(
    () =>
      buildResumeTarget({
        session: openCodeSession,
        source: cleanerSource('opencode', openCodeRoot, {
          databasePath: path.join(temp, 'other.db')
        })
      }),
    /不存在或不可访问/
  )
})

test('nested Codex source keeps the registered config root and legacy OpenCode can resume', async (t) => {
  const temp = await temporaryDirectory(t)
  const configPath = await makeDirectory(path.join(temp, '.codex'))
  const nested = await makeDirectory(path.join(configPath, 'sessions', '2026', '10'))
  const file = await makeFile(path.join(nested, 'rollout.jsonl'))
  const codex = buildResumeTarget({
    session: managedSession('codex', 'nested-id', file),
    source: cleanerSource('codex', nested, { configPath })
  })
  assert.equal(codex.env.CODEX_HOME, configPath)
  const openCodeRoot = await makeDirectory(path.join(temp, 'data', 'opencode'))
  const json = await makeFile(path.join(openCodeRoot, 'storage', 'session', 'ses_legacy.json'))
  const legacy = buildResumeTarget({
    session: managedSession('opencode', 'ses_legacy', json),
    source: cleanerSource('opencode', openCodeRoot)
  })
  assert.deepEqual(legacy.args, ['-s', 'ses_legacy'])
  assert.equal(legacy.env.XDG_DATA_HOME, path.dirname(openCodeRoot))
})
