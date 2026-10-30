import type { CleanerState, SessionCleanerApi } from '../../../../shared/session-cleaner'

export async function recycleAndRefresh(
  api: Pick<SessionCleanerApi, 'recycle' | 'getState'>,
  planId: string,
  onRefresh: (data: CleanerState) => void
): Promise<CleanerState> {
  try {
    return await api.recycle(planId)
  } catch (error) {
    try {
      onRefresh(await api.getState())
    } catch {
      // 刷新失败也保留回收操作的原始错误。
    }
    throw error
  }
}
