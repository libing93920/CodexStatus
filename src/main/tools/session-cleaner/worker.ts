import type {
  CleanerItem,
  CleanerSettings,
  CleanerSource
} from '../../../shared/session-cleaner.ts'
import { discoverSources, identifySource } from './sources.ts'
import { readItemDetails } from './safety.ts'
import { getRunningAgents } from './process-guard.ts'
import { SessionCoreClient } from './core-client.ts'
import { coreSource, scanManagedSources } from './managed-scanner.ts'
import { retainManagedUsage } from './managed-retention.ts'
import { createScanProgressReporter } from './scan-progress.ts'

export interface CleanerWorkerRequest {
  id: number
  method:
    | 'discover'
    | 'identify'
    | 'scan'
    | 'details'
    | 'prepare'
    | 'validate'
    | 'running'
    | 'cancel'
    | 'transcript'
    | 'inspect'
    | 'delete'
    | 'compact'
    | 'block'
  sources?: CleanerSource[]
  source?: CleanerSource
  item?: CleanerItem
  settings?: CleanerSettings
  protectedIds?: string[]
  path?: string
  directory?: string
  contentRef?: unknown
  offset?: number
}

let scanAbort: AbortController | undefined
let core: SessionCoreClient | undefined
const port = process.parentPort

function sessionCore(): SessionCoreClient {
  const executable = process.env.CODEX_STATUS_SESSION_CORE
  if (!executable) throw new Error('缺少会话核心程序路径，请重新构建应用')
  return (core ??= new SessionCoreClient(executable))
}

function sessionParameters(request: CleanerWorkerRequest): Record<string, unknown> {
  if (!request.source || !request.item?.managed) throw new Error('缺少已扫描的会话引用')
  const session = request.item.managed
  if (session.sourceId !== request.source.id || session.providerId !== request.source.kind)
    throw new Error('会话与来源不匹配')
  return { source: coreSource(request.source), session, revision: session.revision }
}

async function handleRequest(request: CleanerWorkerRequest): Promise<unknown> {
  switch (request.method) {
    case 'discover':
      return discoverSources({ registered: request.sources ?? [] })
    case 'identify':
      return identifySource(request.path!)
    case 'running':
      return getRunningAgents()
    case 'cancel':
      scanAbort?.abort()
      core?.dispose('扫描已取消')
      return undefined
    case 'scan': {
      const controller = new AbortController()
      scanAbort = controller
      const progress = createScanProgressReporter((value) => {
        if (scanAbort === controller) port?.postMessage({ progress: value })
      })
      try {
        return await scanManagedSources({
          core: sessionCore(),
          sources: request.sources!,
          settings: request.settings!,
          protectedIds: request.protectedIds!,
          signal: controller.signal,
          onProgress: progress.report
        })
      } finally {
        try {
          progress.finish()
        } finally {
          if (scanAbort === controller) scanAbort = undefined
        }
      }
    }
    case 'details':
      if (request.item?.managed) {
        const details = await sessionCore().request<{ messages: unknown[] }>(
          'read',
          sessionParameters(request)
        )
        return JSON.stringify(details.messages, null, 2)
      }
      return readItemDetails(request.source!, request.item!)
    case 'transcript':
      return sessionCore().request('read', sessionParameters(request))
    case 'block':
      return sessionCore().request('block', {
        ...sessionParameters(request),
        contentRef: request.contentRef,
        offset: request.offset
      })
    case 'validate':
    case 'inspect':
      return sessionCore().request('inspect', sessionParameters(request))
    case 'prepare':
      await sessionCore().request('inspect', sessionParameters(request))
      await retainManagedUsage({ session: request.item!.managed!, directory: request.directory! })
      return sessionCore().request('inspect', sessionParameters(request))
    case 'delete':
      return sessionCore().request('delete', sessionParameters(request))
    case 'compact':
      return sessionCore().request('compact', { source: coreSource(request.source!) })
  }
}

port?.on('message', (event) => {
  const request = event.data as CleanerWorkerRequest
  void handleRequest(request).then(
    (result) => port.postMessage({ id: request.id, result }),
    (error: unknown) =>
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : '工具任务失败'
      })
  )
})
