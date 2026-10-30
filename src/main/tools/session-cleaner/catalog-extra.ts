import type { CleanerSource } from '../../../shared/session-cleaner.ts'
import type { CatalogResult } from './catalog-types.ts'
import { scanAgyCatalog } from './catalog-agy.ts'
import { scanGrokBuildCatalog } from './catalog-grokbuild.ts'
import { scanHermesCatalog } from './catalog-hermes.ts'
import { scanKimiCatalog } from './catalog-kimi.ts'
import { scanMCodeCatalog } from './catalog-mcode.ts'
import { scanOpenClawCatalog } from './catalog-openclaw.ts'
import { scanPiCatalog } from './catalog-pi.ts'

export async function scanExtraCatalog(
  source: CleanerSource,
  signal?: AbortSignal
): Promise<CatalogResult> {
  switch (source.kind) {
    case 'openclaw':
      return scanOpenClawCatalog(source, signal)
    case 'hermes':
      return scanHermesCatalog(source, signal)
    case 'grokbuild':
      return scanGrokBuildCatalog(source, signal)
    case 'omp':
      return scanPiCatalog(source, signal, 'omp')
    case 'mcode':
      return scanMCodeCatalog(source, signal)
    case 'kimi':
      return scanKimiCatalog(source, signal)
    case 'agy':
      return scanAgyCatalog(source, signal)
    default:
      return { sessions: [], issues: [] }
  }
}
