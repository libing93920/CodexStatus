import type { SessionCleanerApi } from '../shared/session-cleaner'

declare global {
  interface Window {
    sessionCleaner: SessionCleanerApi
  }
}
