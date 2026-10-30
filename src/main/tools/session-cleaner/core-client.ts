import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const REQUEST_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export class SessionCoreClient {
  private child?: ChildProcessWithoutNullStreams
  private sequence = 0
  private buffered = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()

  constructor(private readonly executable: string) {}

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.ensureStarted()
    const child = this.child!
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.dispose('会话核心请求超时；请重新扫描后核对结果')
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout })
      child.stdin.write(`${JSON.stringify({ id, method, ...params })}\n`, (error) => {
        if (error && this.child === child) this.dispose(`会话核心通信失败：${error.message}`)
      })
    })
  }

  dispose(reason = '会话核心已停止'): void {
    const child = this.child
    this.child = undefined
    this.buffered = Buffer.alloc(0)
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(new Error(reason))
    }
    this.pending.clear()
    child?.stdin.end()
    child?.kill()
  }

  private ensureStarted(): void {
    if (this.child) return
    const child = spawn(this.executable, [], { stdio: 'pipe', windowsHide: true })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) this.consume(chunk)
    })
    // 诊断走 stderr，绝不把原始正文或用户路径注入错误消息。
    child.stderr.resume()
    child.stdin.on('error', () => {
      if (this.child === child) this.dispose('会话核心输入管道已断开；请重新扫描后核对结果')
    })
    child.once('error', (error) => {
      if (this.child === child) this.dispose(`会话核心无法启动：${error.message}`)
    })
    child.once('exit', () => {
      if (this.child === child) this.dispose('会话核心异常退出；请重新扫描后核对结果')
    })
  }

  private consume(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk])
    if (this.buffered.length > MAX_RESPONSE_BYTES) {
      this.dispose('会话核心响应超过安全上限；未截断数据，请缩小扫描范围')
      return
    }
    let newline = this.buffered.indexOf(10)
    while (newline !== -1) {
      const line = this.buffered.subarray(0, newline).toString('utf8')
      this.buffered = this.buffered.subarray(newline + 1)
      this.deliver(line)
      newline = this.buffered.indexOf(10)
    }
  }

  private deliver(line: string): void {
    let response: { id: number; result?: unknown; error?: string }
    try {
      response = JSON.parse(line)
    } catch {
      this.dispose('会话核心返回无效协议数据')
      return
    }
    const request = this.pending.get(response.id)
    if (!request) return
    clearTimeout(request.timeout)
    this.pending.delete(response.id)
    if (response.error) request.reject(new Error(response.error))
    else request.resolve(response.result)
  }
}
