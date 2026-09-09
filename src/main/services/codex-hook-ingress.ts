import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net, { type Server, type Socket } from 'node:net'
import path from 'node:path'
import { parseCodexHookPayload, type CodexHookPayload } from './codex-hook-events.ts'

const MAX_MESSAGE_BYTES = 128 * 1024

export interface CodexHookEndpoint {
  pipePath: string
  nonce: string
}

export interface CodexHookIngressOptions {
  descriptorPath: string
  onEvent: (payload: CodexHookPayload) => void
}

export class CodexHookIngress {
  private server?: Server
  private endpoint?: CodexHookEndpoint
  private readonly options: CodexHookIngressOptions
  private readonly sockets = new Set<Socket>()

  constructor(options: CodexHookIngressOptions) {
    this.options = options
  }

  async start(): Promise<CodexHookEndpoint> {
    if (this.endpoint) return { ...this.endpoint }
    const endpoint = {
      pipePath: `\\\\.\\pipe\\codex-status-hook-${randomUUID()}`,
      nonce: randomBytes(32).toString('hex')
    }
    const server = net.createServer((socket) => this.handleConnection(socket, endpoint.nonce))
    await listen(server, endpoint.pipePath)
    try {
      await writeDescriptor(this.options.descriptorPath, endpoint)
    } catch (error) {
      await closeServer(server)
      throw error
    }
    this.server = server
    this.endpoint = endpoint
    return { ...endpoint }
  }

  async stop(): Promise<void> {
    const server = this.server
    const endpoint = this.endpoint
    this.server = undefined
    this.endpoint = undefined
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server) await closeServer(server)
    if (endpoint) await removeDescriptor(this.options.descriptorPath, endpoint.nonce)
  }

  private handleConnection(socket: Socket, nonce: string): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    let buffered = Buffer.alloc(0)
    let handled = false
    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > MAX_MESSAGE_BYTES) return finishSocket(socket, false)
      const newline = buffered.indexOf(10)
      if (newline < 0) return
      handled = true
      const payload = parseEnvelope(buffered.subarray(0, newline).toString('utf8'), nonce)
      if (payload) this.options.onEvent(payload)
      finishSocket(socket, Boolean(payload))
    })
    socket.once('error', () => undefined)
  }
}

function parseEnvelope(line: string, nonce: string): CodexHookPayload | undefined {
  try {
    const envelope = JSON.parse(line) as { nonce?: unknown; event?: unknown }
    if (envelope.nonce !== nonce) return undefined
    return parseCodexHookPayload(envelope.event)
  } catch {
    return undefined
  }
}

function finishSocket(socket: Socket, ok: boolean): void {
  socket.end(`${JSON.stringify({ ok })}\n`)
}

async function writeDescriptor(filePath: string, endpoint: CodexHookEndpoint): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(temporaryPath, `${JSON.stringify(endpoint)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await fs.rename(temporaryPath, filePath)
}

async function removeDescriptor(filePath: string, nonce: string): Promise<void> {
  try {
    const descriptor = JSON.parse(await fs.readFile(filePath, 'utf8')) as { nonce?: unknown }
    if (descriptor.nonce === nonce) await fs.unlink(filePath)
  } catch {
    return
  }
}

function listen(server: Server, pipePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipePath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}
