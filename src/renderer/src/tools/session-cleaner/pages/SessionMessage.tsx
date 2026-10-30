import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionBlockContent, SessionMessage } from '../../../../../shared/session-manager'

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : null
}

function textField(record: RecordValue, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '未提供'
  } catch {
    return '无法显示此结构化内容。'
  }
}

function ContentReference({
  sessionId,
  reference,
  label
}: {
  sessionId: string
  reference: unknown
  label: string
}): ReactNode {
  const [content, setContent] = useState<SessionBlockContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const page = await window.sessionCleaner.blockContent(
        sessionId,
        reference,
        content?.nextOffset
      )
      setContent((current) => ({
        ...page,
        text: current ? current.text + page.text : page.text
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取失败，请重试。')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="manager-content-reference">
      {content ? <pre>{content.text}</pre> : null}
      {error ? (
        <p className="manager-content-error" role="alert">
          {error}
        </p>
      ) : null}
      {content?.nextOffset !== undefined || !content ? (
        <button
          className="text-button"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? '读取中…' : content ? `加载更多${label}` : `加载全文：${label}`}
        </button>
      ) : null}
      {content ? (
        <small>
          已读取 {content.text.length} / {content.totalLen} 字符
        </small>
      ) : null}
    </div>
  )
}

function blockReferences(block: RecordValue): Array<{ label: string; reference: unknown }> {
  const references: Array<{ label: string; reference: unknown }> = []
  if (block.full !== undefined) references.push({ label: '正文', reference: block.full })
  if (block.inputFull !== undefined)
    references.push({ label: '工具参数', reference: block.inputFull })
  const diff = asRecord(block.diff)
  if (diff?.full !== undefined) references.push({ label: '完整差异', reference: diff.full })
  return references
}

function ImageSummary({ image }: { image: unknown }): ReactNode {
  const record = asRecord(image)
  if (!record) return <span>图像附件</span>
  const source = asRecord(record.source)
  return (
    <p className="manager-image-summary">
      图像附件 · {textField(record, 'mediaType') || '类型未提供'} ·{' '}
      {typeof record.size === 'number' ? `${record.size} B` : '大小未提供'}
      {textField(record, 'alt') ? ` · ${textField(record, 'alt')}` : ''}
      {source?.kind === 'local_file' && textField(source, 'path')
        ? ` · ${textField(source, 'path')}`
        : ''}
    </p>
  )
}

function blockTitle(block: RecordValue, type: string): string {
  if (type === 'tool_call')
    return `工具调用 · ${textField(block, 'title') || textField(block, 'rawName') || '未提供名称'}`
  if (type === 'tool_result') return `工具输出 · ${textField(block, 'status') || '状态未提供'}`
  if (type === 'thinking') return textField(block, 'summary') || '思考内容'
  if (type === 'image') return '图像附件'
  if (type === 'event') return `事件 · ${textField(block, 'kind') || '未提供类型'}`
  if (type === 'step') return `步骤 · ${textField(block, 'phase') || '未提供阶段'}`
  return type || '结构化内容块'
}

function BlockBody({ block, sessionId }: { block: RecordValue; sessionId: string }): ReactNode {
  const type = textField(block, 'type')
  const references = blockReferences(block)
  const diff = asRecord(block.diff)
  const images = Array.isArray(block.images) ? block.images : []
  return (
    <>
      {type === 'text' || type === 'thinking' ? (
        <pre className="session-excerpt">
          {textField(block, 'text') || textField(block, 'summary') || '（空内容）'}
        </pre>
      ) : null}
      {type === 'tool_call' ? (
        <>
          {textField(block, 'detail') ? <p>{textField(block, 'detail')}</p> : null}
          <pre className="session-excerpt">
            {textField(block, 'inputPreview') || '没有参数预览。'}
          </pre>
          {diff ? (
            <pre className="session-excerpt">
              差异摘要：{safeJson({ files: diff.files, added: diff.added, removed: diff.removed })}
            </pre>
          ) : null}
        </>
      ) : null}
      {type === 'tool_result' ? (
        <pre className="session-excerpt">{textField(block, 'preview') || '没有输出预览。'}</pre>
      ) : null}
      {type === 'image' ? <ImageSummary image={block.image} /> : null}
      {type === 'event' ? (
        <>
          {textField(block, 'text') ? (
            <pre className="session-excerpt">{textField(block, 'text')}</pre>
          ) : null}
          {textField(block, 'url') ? <code>{textField(block, 'url')}</code> : null}
        </>
      ) : null}
      {type === 'step' ? (
        <pre className="session-excerpt">
          {safeJson({ tokens: block.tokens, costUsd: block.costUsd, reason: block.reason })}
        </pre>
      ) : null}
      {type === 'thinking' && block.redacted === true ? (
        <p className="muted">正文已被来源隐藏。</p>
      ) : null}
      {images.map((image, index) => (
        <ImageSummary key={index} image={image} />
      ))}
      {references.map(({ label, reference }) => (
        <ContentReference
          key={`${type}-${label}`}
          sessionId={sessionId}
          reference={reference}
          label={label}
        />
      ))}
      {type !== 'text' ? (
        <details className="manager-message-extra">
          <summary>查看完整块字段</summary>
          <pre>{safeJson(block)}</pre>
        </details>
      ) : null}
    </>
  )
}

function MessageBlocks({
  message,
  sessionId
}: {
  message: SessionMessage
  sessionId: string
}): ReactNode {
  const blocks = Array.isArray(message.blocks)
    ? message.blocks.map(asRecord).filter((block): block is RecordValue => Boolean(block))
    : []
  if (!blocks.length)
    return <pre className="session-excerpt">{message.content || '（空消息）'}</pre>
  return (
    <div className="manager-message-blocks">
      {blocks.map((block, index) => {
        const type = textField(block, 'type')
        const title = blockTitle(block, type)
        if (type === 'text')
          return <BlockBody key={`${type}-${index}`} block={block} sessionId={sessionId} />
        return (
          <details className="manager-session-block" key={`${type}-${index}`}>
            <summary>{title}</summary>
            <BlockBody block={block} sessionId={sessionId} />
          </details>
        )
      })}
    </div>
  )
}

function MessageMetadata({ message }: { message: SessionMessage }): ReactNode {
  const fields = Object.fromEntries(
    Object.entries(message).filter(([key]) => !['role', 'content', 'blocks'].includes(key))
  )
  if (!Object.keys(fields).length) return null
  return (
    <details className="manager-message-extra">
      <summary>消息元数据</summary>
      <pre>{safeJson(fields)}</pre>
    </details>
  )
}

function SessionMessageCard({
  message,
  sessionId,
  index
}: {
  message: SessionMessage
  sessionId: string
  index: number
}): ReactNode {
  return (
    <article className="manager-message" data-role={message.role}>
      <header>
        <strong>
          {{ user: '你', assistant: '助手', system: '系统', tool: '工具' }[message.role] ??
            (message.role || '未提供角色')}
        </strong>
        <span>消息 {index + 1}</span>
      </header>
      <MessageBlocks message={message} sessionId={sessionId} />
    </article>
  )
}

export function SessionMessageList({
  messages,
  sessionId
}: {
  messages: SessionMessage[]
  sessionId: string
}): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const visibleMessages = showAll ? messages : messages.slice(-30)
  const firstIndex = messages.length - visibleMessages.length
  return (
    <section className="manager-transcript" aria-label="会话正文">
      <div className="manager-section-heading">
        <h3>会话内容</h3>
        <span>{messages.length} 条消息</span>
      </div>
      {messages.length > visibleMessages.length ? (
        <button className="text-button" type="button" onClick={() => setShowAll(true)}>
          显示全部 {messages.length} 条消息
        </button>
      ) : null}
      {visibleMessages.map((message, index) => (
        <SessionMessageCard
          key={
            typeof message.id === 'string' ? message.id : `${message.role}-${firstIndex + index}`
          }
          message={message}
          sessionId={sessionId}
          index={firstIndex + index}
        />
      ))}
      {!messages.length ? <p className="muted">没有可显示的正文消息。</p> : null}
      {messages.length ? (
        <details className="calm-transcript-meta">
          <summary>消息信息</summary>
          {visibleMessages.map((message, index) => (
            <MessageMetadata key={index} message={message} />
          ))}
        </details>
      ) : null}
    </section>
  )
}
