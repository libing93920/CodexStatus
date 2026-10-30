const DAY_MS = 86_400_000
const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime()

function makeStorage(overrides = {}) {
  return {
    kind: 'file',
    fileBytes: 2 * 1024 ** 2,
    logicalBytes: 4 * 1024 ** 2,
    sharedBytes: 0,
    complete: true,
    ...overrides
  }
}

function makeSession(id, sourceId, overrides = {}) {
  const managed = {
    providerId: sourceId.startsWith('claude') ? 'claude' : 'codex',
    sourceId,
    sessionId: id,
    sourcePath: `F:\\Agents\\${sourceId}\\${id}.jsonl`,
    modelIds: ['gpt-5.6'],
    capabilities: { read: true, delete: true, export: true, resume: true },
    storage: makeStorage(),
    resourceIds: [],
    revision: `revision:${id}`,
    ...overrides.managed
  }
  const createdAt = overrides.createdAt ?? new Date(2026, 7, 14, 12, 0, 0).getTime()
  const modifiedAt = overrides.modifiedAt ?? createdAt
  return {
    id,
    sourceId,
    title: `会话 ${id}`,
    path: managed.sourcePath,
    project: 'Atlas',
    sessionId: id,
    summary: `测试摘要 ${id}`,
    createdAt,
    bytes: 1024 ** 2,
    modifiedAt,
    category: 'sessions',
    status: 'candidate',
    reason: '',
    files: [managed.sourcePath],
    fingerprint: `fixture:${id}`,
    managed,
    recommendation: 'normal',
    ...overrides,
    managed
  }
}

export function createSessionManagerFixtureState(extraSessions = 0) {
  const parent = makeSession('codex-parent', 'codex-main', {
    status: 'recent',
    recommendation: 'recent',
    managed: {
      messageCount: 12,
      lastActiveAt: NOW - 4 * DAY_MS,
      storage: makeStorage({ fileBytes: 900_000, logicalBytes: 1_400_000 })
    }
  })
  const child = makeSession('codex-child', 'codex-archive', {
    createdAt: new Date(2026, 7, 14, 12, 0, 0).getTime(),
    modifiedAt: new Date(2026, 7, 15, 12, 0, 0).getTime(),
    bytes: 2 * 1024 ** 2,
    managed: {
      parentSessionId: 'codex-parent',
      messageCount: 25,
      lastActiveAt: NOW - 120 * DAY_MS,
      modelIds: ['gpt-5.6', 'o4-mini'],
      storage: makeStorage({ fileBytes: 1.5 * 1024 ** 2, logicalBytes: 4 * 1024 ** 2 })
    },
    recommendation: 'old'
  })
  const active = makeSession('codex-active', 'codex-main', {
    status: 'active',
    managed: { capabilities: { read: true, delete: true, export: true, resume: true } }
  })
  const protectedSession = makeSession('codex-protected', 'codex-main', {
    status: 'protected',
    managed: { capabilities: { read: true, delete: true, export: true, resume: false } }
  })
  const missing = makeSession('codex-missing', 'codex-main', {
    status: 'read-only',
    project: undefined,
    managed: {
      modelIds: [],
      messageCount: undefined,
      lastActiveAt: undefined,
      parentSessionId: undefined,
      capabilities: { read: true, delete: false, export: false, resume: false },
      storage: makeStorage({ logicalBytes: undefined })
    }
  })
  const claude = makeSession('claude-session', 'claude-main', {
    managed: {
      providerId: 'claude',
      modelIds: ['claude-sonnet'],
      capabilities: { read: true, delete: true, export: true, resume: true }
    }
  })
  const resource = {
    id: 'resource-fixture',
    sourceId: 'codex-main',
    title: '共享附件',
    path: 'F:\\Agents\\codex-main\\shared.bin',
    project: 'Atlas',
    bytes: 512 * 1024,
    modifiedAt: NOW - DAY_MS,
    category: 'resources',
    status: 'candidate',
    reason: '',
    files: ['F:\\Agents\\codex-main\\shared.bin'],
    fingerprint: 'fixture:resource'
  }
  const items = [parent, child, active, protectedSession, missing, claude, resource]
  for (let index = 0; index < extraSessions; index += 1) {
    items.push(
      makeSession(`codex-extra-${index}`, 'codex-main', {
        title: `额外会话 ${index}`,
        managed: { messageCount: index, lastActiveAt: NOW - index * DAY_MS }
      })
    )
  }
  return {
    sources: [
      {
        id: 'codex-main',
        kind: 'codex',
        name: 'Codex',
        path: 'F:\\Agents\\codex-main',
        capability: 'sessions'
      },
      {
        id: 'codex-archive',
        kind: 'codex',
        name: 'Codex 归档',
        path: 'F:\\Agents\\codex-archive',
        capability: 'sessions'
      },
      {
        id: 'claude-main',
        kind: 'claude',
        name: 'Claude',
        path: 'F:\\Agents\\claude-main',
        capability: 'sessions'
      }
    ],
    items,
    issues: [],
    settings: { keepRecentDays: 14, olderSessionDays: 90, logAgeDays: 30, alertGiB: 20 },
    records: [],
    scannedAt: NOW,
    scanning: false,
    recycling: false,
    disks: [],
    resources: [
      {
        id: 'codex-attachment',
        sourceId: 'codex-main',
        sourceIds: ['codex-main', 'codex-archive'],
        path: 'F:\\Agents\\codex\\shared.bin',
        kind: 'attachment',
        bytes: 512,
        sessionIds: ['codex-parent', 'codex-child'],
        shared: true
      },
      {
        id: 'codex-database',
        sourceId: 'codex-main',
        sourceIds: ['codex-main'],
        path: 'F:\\Agents\\codex\\state.sqlite',
        kind: 'database',
        bytes: 1000,
        sessionIds: [],
        shared: false
      },
      {
        id: 'codex-wal',
        sourceId: 'codex-archive',
        sourceIds: ['codex-main', 'codex-archive'],
        path: 'F:\\Agents\\codex\\state.sqlite-wal',
        kind: 'wal',
        bytes: 50,
        sessionIds: [],
        shared: true
      },
      {
        id: 'codex-transcript',
        sourceId: 'codex-archive',
        sourceIds: ['codex-archive'],
        path: 'F:\\Agents\\codex\\archive.jsonl',
        kind: 'transcript',
        bytes: 200,
        sessionIds: ['codex-child'],
        shared: false
      },
      {
        id: 'cross-agent-resource',
        sourceId: 'codex-main',
        sourceIds: ['codex-main', 'claude-main'],
        path: 'F:\\Shared\\prompt.bin',
        kind: 'attachment',
        bytes: 70,
        sessionIds: ['codex-parent', 'claude-session'],
        shared: true
      }
    ],
    storage: [
      {
        sourceId: 'codex-main',
        fileBytes: 100,
        databaseBytes: 200,
        walBytes: 30,
        sharedBytes: 40,
        otherBytes: 50,
        databaseFreeBytes: 60,
        complete: true
      },
      {
        sourceId: 'codex-archive',
        fileBytes: 10,
        databaseBytes: 20,
        walBytes: 3,
        sharedBytes: 4,
        otherBytes: 5,
        databaseFreeBytes: 6,
        complete: true
      }
    ],
    deletionMode: 'permanent'
  }
}
