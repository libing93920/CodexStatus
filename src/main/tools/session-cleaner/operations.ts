import { dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { CleanerController } from './controller.ts'
import { buildResumeTarget } from './resume-target.ts'

const MAX_EXPORT_NAME_LENGTH = 100
// Windows 文件名不能包含控制字符。
// eslint-disable-next-line no-control-regex
const INVALID_EXPORT_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g

export async function exportSessions(options: {
  window: BrowserWindow
  tool: CleanerController
  ids: string[]
}): Promise<{ count: number; cancelled: boolean }> {
  const { window, tool, ids } = options
  const items = tool.selectedForExport(ids)
  if (!items.length) throw new Error('所选会话不支持导出')
  const result = await dialog.showOpenDialog(window, {
    title: '选择 Markdown 导出目录（用于阅读，不是原格式恢复包）',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled) return { count: 0, cancelled: true }
  let count = 0
  const batchId = randomUUID()
  tool.beginExport()
  try {
    for (const item of items) {
      if (tool.isOperationCancelled()) break
      const exported = await tool.exportContent(item.id)
      const name = `${safeName(exported.title)}-${item.id.slice(0, 8)}-${batchId.slice(0, 8)}.md`
      // 导出用于阅读；不覆盖目录中已有文件，也不宣称可恢复原工具状态。
      await writeFile(path.join(result.filePaths[0], name), exported.markdown, {
        encoding: 'utf8',
        flag: 'wx'
      })
      await tool.recordOperation({
        batchId,
        sourceId: item.sourceId,
        title: item.title,
        path: path.join(result.filePaths[0], name),
        bytes: Buffer.byteLength(exported.markdown, 'utf8'),
        status: 'exported'
      })
      count++
      tool.reportProgress({
        phase: 'export',
        visited: count,
        bytes: 0,
        completed: count,
        total: items.length
      })
    }
    return { count, cancelled: tool.isOperationCancelled() }
  } finally {
    tool.finishExport()
  }
}

export async function resumeSession(tool: CleanerController, id: string): Promise<void> {
  const { item, source } = await tool.resumeTarget(id)
  if (process.platform !== 'win32') throw new Error('当前终端续聊仅在 Windows 完成实现')
  const target = buildResumeTarget({ session: item.managed!, source })
  const script = [
    ...Object.entries(target.env).map(([key, value]) => `$env:${key}=${psQuote(value)}`),
    `& ${[target.executable, ...target.args].map(psQuote).join(' ')}`
  ].join('\n')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      cwd: target.cwd,
      detached: true,
      windowsHide: false,
      stdio: 'ignore'
    }
  )
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', resolve)
  })
  child.unref()
}

function safeName(title: string): string {
  const name = title
    .replace(INVALID_EXPORT_FILENAME, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_EXPORT_NAME_LENGTH)
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? `会话_${name}` : name
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
