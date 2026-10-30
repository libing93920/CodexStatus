/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 只读视觉验收数据；来源、资源和文案照录本地 AgentSpace 原型演示值。
const BYTES_PER_GIB = 1024 ** 3
const UNITS_PER_GIB = 10
const SCANNED_AT = Date.parse('2026-10-28T10:48:00+08:00')
const WINDOWS_SEPARATOR = String.fromCharCode(92)

function windowsPath(segments) {
  return segments.join(WINDOWS_SEPARATOR)
}

const SOURCE_DEMOS = [
  {
    id: 'codex',
    kind: 'codex',
    name: 'Codex',
    path: windowsPath(['C:', 'Users', 'demo', '.codex']),
    capability: 'sessions'
  },
  {
    id: 'claude',
    kind: 'claude',
    name: 'Claude Code',
    path: windowsPath(['C:', 'Users', 'demo', '.claude']),
    capability: 'sessions'
  },
  {
    id: 'opencode',
    kind: 'opencode',
    name: 'OpenCode',
    path: windowsPath(['C:', 'Users', 'demo', '.local', 'share', 'opencode']),
    capability: 'sessions'
  },
  {
    id: 'pi',
    kind: 'pi',
    name: 'Pi',
    path: windowsPath(['C:', 'Users', 'demo', '.pi', 'agent']),
    capability: 'sessions'
  },
  {
    id: 'gemini',
    kind: 'gemini',
    name: 'Gemini CLI',
    path: windowsPath(['C:', 'Users', 'demo', '.gemini']),
    capability: 'sessions'
  },
  {
    id: 'cline',
    kind: 'cline',
    name: 'Cline',
    path: windowsPath(['C:', 'AgentData', 'cline-example']),
    capability: 'files'
  },
  {
    id: 'custom',
    kind: 'unknown',
    name: 'Custom Agent',
    path: windowsPath(['D:', 'AgentData', 'custom-agent']),
    capability: 'files'
  }
]

const RESOURCE_DEMOS = [
  {
    id: 'r1',
    sourceId: 'codex',
    title: '旧版界面探索',
    units: 24,
    date: '2026-07-28',
    status: 'candidate',
    path: 'example-session-01',
    category: 'sessions',
    project: windowsPath(['F:', 'Projects', 'InterfaceLab']),
    fileCount: 16,
    reason: '演示适配器已确认资源独占；更新时间仅供审核参考。'
  },
  {
    id: 'r2',
    sourceId: 'claude',
    title: '落地页视觉提案',
    units: 18,
    date: '2026-08-14',
    status: 'candidate',
    path: 'example-session-02',
    category: 'sessions',
    project: windowsPath(['F:', 'Projects', 'LandingPage']),
    fileCount: 12,
    reason: '演示资源包无保留会话引用；仍需用户确认内容价值。'
  },
  {
    id: 'r3',
    sourceId: 'gemini',
    title: '批量图片处理试验',
    units: 16,
    date: '2026-08-19',
    status: 'candidate',
    path: 'example-session-03',
    category: 'sessions',
    project: windowsPath(['D:', 'Projects', 'ImageTools']),
    fileCount: 28,
    reason: '演示关联清单完整；根目录外输出已排除。'
  },
  {
    id: 'r4',
    sourceId: 'opencode',
    title: '临时构建日志',
    units: 10,
    date: '2026-09-03',
    status: 'candidate',
    path: 'example-logs-04',
    category: 'logs',
    project: windowsPath(['F:', 'Projects', 'BuildTools']),
    fileCount: 6,
    reason: '示例为独立日志文件组，不包含共享数据库或检查点。'
  },
  {
    id: 'r5',
    sourceId: 'codex',
    title: 'AgentSpace 布局草案',
    units: 9,
    date: '2026-10-28',
    status: 'active',
    path: 'example-active-05',
    category: 'sessions',
    project: windowsPath(['F:', 'Tools', 'AgentSpace']),
    fileCount: 8,
    reason: '示例会话正在使用，不允许选中清理。'
  },
  {
    id: 'r6',
    sourceId: 'pi',
    title: 'Unity 编辑器工具',
    units: 3,
    date: '2026-10-20',
    status: 'protected',
    path: 'example-session-06',
    category: 'sessions',
    project: windowsPath(['F:', 'Projects', 'UnityTools']),
    fileCount: 3,
    reason: '用户标记保留；保护状态优先于时间和空间大小。'
  },
  {
    id: 'r7',
    sourceId: 'cline',
    title: '编辑器任务记录',
    units: 17,
    date: '2026-10-12',
    status: 'read-only',
    path: 'example-tasks-07',
    category: 'unknown',
    project: '未识别项目',
    fileCount: 21,
    reason: '演示适配器尚未验证检查点与任务的回收关系，仅开放查看。'
  },
  {
    id: 'r8',
    sourceId: 'custom',
    title: '未识别的数据文件',
    units: 10,
    date: '2026-10-09',
    status: 'read-only',
    path: 'visual-fixture-unparsed',
    category: 'unknown',
    project: '未识别项目',
    fileCount: 9,
    reason: '可以统计文件，无法确认会话格式与共享引用，因此不能清理。'
  }
]

export const SESSION_CLEANER_VISUAL_STATE = {
  sources: SOURCE_DEMOS.map((source, index) => ({
    ...source,
    origin: index < 5 ? 'discovered' : 'manual',
    note: '只用于视觉验收；不读取此演示路径。'
  })),
  items: RESOURCE_DEMOS.map((resource) => {
    const source = SOURCE_DEMOS.find((entry) => entry.id === resource.sourceId)
    return {
      id: resource.id,
      sourceId: resource.sourceId,
      title: resource.title,
      path: windowsPath([source.path, resource.path]),
      project: resource.project,
      bytes: Math.round((resource.units * BYTES_PER_GIB) / UNITS_PER_GIB),
      modifiedAt: Date.parse(`${resource.date}T12:00:00+08:00`),
      category: resource.category,
      status: resource.status,
      reason: resource.reason,
      files: Array.from(
        { length: resource.fileCount },
        (_, index) => `visual-fixture-${resource.id}-${String(index + 1).padStart(2, '0')}.dat`
      ),
      fingerprint: `visual-fixture:${resource.id}:v1`
    }
  }),
  issues: [],
  settings: { keepRecentDays: 14, olderSessionDays: 90, logAgeDays: 30, alertGiB: 20 },
  records: [],
  scannedAt: SCANNED_AT,
  scanning: false,
  recycling: false,
  disks: [
    {
      path: 'C:',
      available: Math.round(21.8 * BYTES_PER_GIB),
      total: 256 * BYTES_PER_GIB
    }
  ]
}

export function copySessionCleanerVisualState() {
  return structuredClone(SESSION_CLEANER_VISUAL_STATE)
}

export function createSessionCleanerVisualPlan(ids) {
  const selected = new Set(ids)
  const items = SESSION_CLEANER_VISUAL_STATE.items.filter((item) => selected.has(item.id))
  return {
    id: 'visual-only-plan',
    createdAt: SCANNED_AT,
    items: structuredClone(items),
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
    excluded: []
  }
}
