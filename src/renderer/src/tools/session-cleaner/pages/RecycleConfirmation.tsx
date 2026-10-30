import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../components'
import { formatBytes } from '../model'

export function ConfirmationDialog({
  open,
  count,
  attributedBytes,
  logicalBytes,
  warnings,
  exportableCount,
  busy,
  onClose,
  onConfirm
}: {
  open: boolean
  count: number
  attributedBytes: number
  logicalBytes?: number
  warnings: string[]
  exportableCount: number
  busy: boolean
  onClose: () => void
  onConfirm: (exportBeforeDelete: boolean) => void
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [exportBeforeDelete, setExportBeforeDelete] = useState(false)
  const canExportAll = count > 0 && exportableCount === count
  useEffect(() => {
    const dialog = dialogRef.current
    if (open && dialog && !dialog.open) dialog.showModal()
    if (!open && dialog?.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog manager-confirm-dialog"
      aria-labelledby="confirm-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">PERMANENT DELETE</span>
          <h2 id="confirm-title">确认永久删除</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭删除确认">
          <Icon name="close" />
        </button>
      </div>
      <p className="dialog-intro">
        即将永久删除 <strong>{count}</strong> 项。关联文件 {formatBytes(attributedBytes)}
        {logicalBytes === undefined ? '' : ` · 会话数据 ${formatBytes(logicalBytes)}`}。
      </p>
      <div className="audit-impact manager-delete-impact" role="alert">
        <Icon name="info" />
        <strong>永久删除不能通过系统回收站还原。确认前会再次核验数据库与关联文件。</strong>
      </div>
      {warnings.length ? (
        <ul className="manager-delete-warnings" aria-label="删除预览警告">
          {warnings.map((warning, index) => (
            <li key={`${warning}-${index}`}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <label className="manager-export-before-delete">
        <input
          type="checkbox"
          checked={exportBeforeDelete}
          disabled={!canExportAll || busy}
          onChange={(event) => setExportBeforeDelete(event.currentTarget.checked)}
        />
        <span>
          先导出所选会话，再删除
          <small>
            {canExportAll
              ? '导出未完成或被取消时，将停止删除。'
              : `仅 ${exportableCount}/${count} 项支持导出；可返回单独导出支持的会话。`}
          </small>
        </span>
      </label>
      <p className="dialog-note">
        操作完成后按会话逐项记录结果；删除后实际释放空间需以重新扫描为准。
      </p>
      <div className="dialog-actions">
        <button className="button" type="button" onClick={onClose} disabled={busy}>
          返回检查
        </button>
        <button
          className="button danger"
          type="button"
          onClick={() => onConfirm(exportBeforeDelete)}
          disabled={busy}
        >
          <Icon name="records" />
          {busy ? '正在处理…' : exportBeforeDelete ? '导出并永久删除' : '永久删除'}
        </button>
      </div>
    </dialog>
  )
}
