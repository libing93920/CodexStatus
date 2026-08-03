// 临时诊断日志:追加到 ~/.codex-status-debug.log,排查同事机器上 API 模式识别问题。
// 定位完成后移除本模块。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEBUG_LOG_PATH = path.join(os.homedir(), '.codex-status-debug.log')

export async function debugLog(message: string): Promise<void> {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`
    await fs.appendFile(DEBUG_LOG_PATH, line, 'utf8')
  } catch {
    // 写入失败不影响功能
  }
}
