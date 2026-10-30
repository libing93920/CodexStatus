import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { CleanerProgress } from '../../../shared/session-cleaner.ts'
import type { CleanerWorkerRequest } from './worker.ts'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CleanerWorkerClient {
  private child: UtilityProcess | undefined
  private sequence = 0
  private readonly pending = new Map<number, PendingRequest>()

  constructor(
    private readonly onProgress: (progress: CleanerProgress) => void,
    private readonly coreExecutable: string
  ) {}

  request<T>(request: Omit<CleanerWorkerRequest, 'id'>): Promise<T> {
    this.ensureWorker()
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.child!.postMessage({ ...request, id })
    })
  }

  dispose(): void {
    this.rejectPending('扫描进程已停止，请重新操作')
    this.child?.kill()
    this.child = undefined
  }

  private ensureWorker(): void {
    if (this.child) return
    const child = utilityProcess.fork(path.join(__dirname, 'session-cleaner-worker.js'), [], {
      stdio: 'ignore',
      env: { ...process.env, CODEX_STATUS_SESSION_CORE: this.coreExecutable },
      serviceName: 'CodexStatus 会话清理'
    })
    this.child = child
    child.on('message', (message) => {
      if (message.progress) {
        this.onProgress(message.progress)
        return
      }
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(String(message.error)))
      else request.resolve(message.result)
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      this.rejectPending('扫描进程异常退出，审核已停止，请重新扫描')
    })
  }

  private rejectPending(message: string): void {
    for (const request of this.pending.values()) request.reject(new Error(message))
    this.pending.clear()
  }
}
