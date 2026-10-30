import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Feedback, Sidebar, WorkspaceHeader } from './Shell'
import { useSessionCleaner } from './hooks'
import { DEFAULT_ITEM_FILTERS } from './model'
import { groupSources } from './source-groups'
import type { SessionCleanerController } from './hooks'
import { OverviewPage } from './pages/OverviewPage'
import { ItemsPage } from './pages/ItemsPage'
import { SourcesPage } from './pages/SourcesPage'
import { ReviewPage } from './pages/ReviewPage'
import { RecordsPage } from './pages/RecordsPage'
import { PolicyPage } from './pages/PolicyPage'
import { AnalyticsPage } from './pages/AnalyticsPage'
import type { CleanerItem } from '../../../../shared/session-cleaner'

function renderPage(controller: SessionCleanerController, selectedItems: CleanerItem[]): ReactNode {
  const { ui } = controller
  const data = ui.data
  if (ui.page === 'overview')
    return (
      <OverviewPage
        data={data}
        scanActive={controller.scanActive}
        isBusy={controller.isBusy}
        cancelPending={ui.cancelPending}
        onScan={controller.scan}
        onCancelScan={controller.cancelScan}
        onItems={() => {
          controller.setFilters({
            ...DEFAULT_ITEM_FILTERS,
            category: 'sessions',
            deletion: 'allowed'
          })
          controller.setPage('items')
        }}
        onSources={() => controller.setPage('sources')}
        onSourceSelect={(sourceId) => {
          controller.setFilters({
            ...DEFAULT_ITEM_FILTERS,
            sourceId,
            status: 'all',
            category:
              data &&
              groupSources(data).find((source) => source.id === sourceId)?.capability === 'files'
                ? 'all'
                : 'sessions'
          })
          controller.setPage('items')
        }}
      />
    )
  if (ui.page === 'items')
    return (
      <ItemsPage
        data={data}
        filters={ui.filters}
        selectedIds={ui.selectedIds}
        detailId={ui.detailId}
        details={ui.detailId ? ui.details[ui.detailId] : undefined}
        detailLoaded={
          ui.detailId ? Object.prototype.hasOwnProperty.call(ui.details, ui.detailId) : false
        }
        isBusy={controller.isBusy}
        detailsLoading={ui.busy === 'details' || Boolean(ui.detailReloadId)}
        canReview={controller.canReview}
        onFilters={controller.setFilters}
        onSelect={controller.toggleSelection}
        onSelectVisible={controller.toggleVisibleSelection}
        onClearSelection={controller.clearSelection}
        onProtect={controller.protect}
        onDetails={controller.openDetails}
        onCloseDetails={controller.closeDetails}
        onReveal={controller.reveal}
        onExport={controller.exportSessions}
        onResume={controller.resumeSession}
        onReview={() => {
          controller.setPage('review')
          controller.createReview()
        }}
        onScan={controller.scan}
      />
    )
  if (ui.page === 'sources')
    return (
      <SourcesPage
        data={data}
        isBusy={controller.isBusy}
        onDiscover={controller.discover}
        onImport={controller.importSource}
        onRemove={controller.removeSource}
      />
    )
  if (ui.page === 'review')
    return (
      <ReviewPage
        data={data}
        selectedItems={selectedItems}
        plan={ui.plan}
        invalidated={ui.reviewInvalidated}
        confirmOpen={ui.confirmOpen}
        canReview={controller.canReview}
        canDelete={controller.canDelete}
        isBusy={controller.isBusy}
        onCreateReview={controller.createReview}
        onOpenConfirmation={controller.openConfirmation}
        onCloseConfirmation={controller.closeConfirmation}
        onConfirmDelete={controller.confirmDelete}
        onItems={() => controller.setPage('items')}
      />
    )
  if (ui.page === 'records')
    return (
      <RecordsPage
        data={data}
        isBusy={controller.isBusy}
        onOpenRecycleBin={controller.openRecycleBin}
      />
    )
  if (ui.page === 'analytics')
    return (
      <AnalyticsPage
        data={data}
        isBusy={controller.isBusy}
        onCompactDatabase={controller.compactDatabase}
        onOpenAgent={(sourceId) => {
          controller.setFilters({
            ...DEFAULT_ITEM_FILTERS,
            sourceId,
            category:
              data &&
              groupSources(data).find((source) => source.id === sourceId)?.capability === 'files'
                ? 'all'
                : 'sessions'
          })
          controller.setPage('items')
        }}
      />
    )
  return (
    <PolicyPage
      saved={data?.settings ?? null}
      draft={ui.settingsDraft}
      isBusy={controller.isBusy}
      onChange={controller.changeSetting}
      onReset={controller.resetSettings}
      onSave={controller.saveSettings}
    />
  )
}

export default function SessionCleanerApp(): ReactNode {
  const controller = useSessionCleaner()
  const items = controller.ui.data?.items
  const selectedIds = controller.ui.selectedIds
  const selectedItems = useMemo(() => {
    if (!items || !selectedIds.length) return []
    const selected = new Set(selectedIds)
    return items.filter((item) => selected.has(item.id))
  }, [items, selectedIds])
  useEffect(() => {
    document.getElementById(`${controller.ui.page}-heading`)?.focus()
  }, [controller.ui.page])
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <Sidebar controller={controller} />
      <div className="main-shell">
        <WorkspaceHeader controller={controller} />
        <main id="main-content" className="main-content" tabIndex={-1}>
          <section
            className={'page page-' + controller.ui.page}
            key={controller.ui.page}
            aria-labelledby={`${controller.ui.page}-heading`}
          >
            {renderPage(controller, selectedItems)}
          </section>
        </main>
      </div>
      <Feedback controller={controller} />
    </div>
  )
}
