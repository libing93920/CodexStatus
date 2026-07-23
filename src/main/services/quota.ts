import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { RateLimitSource, RateLimitWindowSnapshot, UsageSnapshot } from '../../shared/capsule'

interface RawRateLimit {
  windowMinutes?: number
  usedPercent?: number
  resetsAtMs?: number
  resetsInSeconds?: number
}

interface RateLimitSnapshot {
  timestamp: Date
  primary?: RawRateLimit
  secondary?: RawRateLimit
}

interface JsonlFileEntry {
  filePath: string
  mtimeMs: number
}

interface OfficialRateLimitLookup {
  rateLimits?: UsageSnapshot['rateLimits']
  canRefresh: boolean
  issue?: string
}

interface CredentialLookup {
  credentials?: {
    accessToken: string
    accountId?: string
  }
  canRefresh: boolean
  issue?: string
}

const SESSION_SUBDIR = 'sessions'
const OFFICIAL_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const OFFICIAL_QUOTA_TIMEOUT_MS = 8000
const OFFICIAL_QUOTA_RECHECK_DELAY_MS = 1000
const FILE_SCAN_LIMIT = 80
export async function collectUsageSnapshot(): Promise<UsageSnapshot> {
  const checkedPaths = resolveSessionPaths()
  const missingPaths: string[] = []
  const files: JsonlFileEntry[] = []

  for (const candidate of checkedPaths) {
    if (!(await pathExists(candidate))) {
      missingPaths.push(candidate)
      continue
    }

    files.push(...(await collectJsonlFiles(candidate, FILE_SCAN_LIMIT * 3)))
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const limitedFiles = files.slice(0, FILE_SCAN_LIMIT)
  let latestLocalSnapshot: RateLimitSnapshot | undefined

  for (const entry of limitedFiles) {
    const snapshot = await readLatestRateLimitSnapshot(entry.filePath)
    if (snapshot && (!latestLocalSnapshot || snapshot.timestamp > latestLocalSnapshot.timestamp)) {
      latestLocalSnapshot = snapshot
    }
  }

  const localRateLimits = toRateLimits(latestLocalSnapshot)
  let rateLimits = localRateLimits
  let rateLimitSource: RateLimitSource = hasRateLimits(localRateLimits) ? 'local' : 'none'
  let officialIssue: string | undefined

  const officialLookup = await getOfficialRateLimits(localRateLimits)
  if (officialLookup.rateLimits !== undefined) {
    rateLimits = officialLookup.rateLimits
    rateLimitSource = 'official'
  } else {
    officialIssue = officialLookup.issue
  }

  const issues: string[] = []
  if (rateLimitSource !== 'official' && officialIssue) {
    issues.push(`官方额度不可用：${officialIssue}`)
  }
  if (rateLimitSource === 'none' && missingPaths.length === checkedPaths.length) {
    issues.push('未找到 Codex sessions 目录')
  }
  if (rateLimitSource === 'local' && limitedFiles.length === 0) {
    issues.push('本地 sessions 中没有可解析的额度窗口')
  }

  return {
    available: hasRateLimits(rateLimits),
    isRefreshing: false,
    canRefresh: officialLookup.canRefresh,
    generatedAt: new Date().toISOString(),
    rateLimits,
    rateLimitSource,
    sourceHost: resolveSourceHost(rateLimitSource),
    officialIssue,
    issues: Array.from(new Set(issues)).slice(0, 6),
    filesScanned: limitedFiles.length,
    sessionsPath: checkedPaths.find((candidate) => !missingPaths.includes(candidate))
  }
}

async function getOfficialRateLimits(
  localRateLimits: UsageSnapshot['rateLimits']
): Promise<OfficialRateLimitLookup> {
  const credentialLookup = await readOfficialCodexCredentials()
  if (!credentialLookup.credentials) {
    return {
      canRefresh: credentialLookup.canRefresh,
      issue: credentialLookup.issue ?? '未找到 Codex OAuth 凭据'
    }
  }

  const headers = buildOfficialHeaders(credentialLookup.credentials)

  try {
    let rateLimits = await requestOfficialRateLimits(headers)
    if (rateLimits && shouldRecheckOfficialRateLimits(rateLimits, localRateLimits)) {
      await new Promise((resolve) => setTimeout(resolve, OFFICIAL_QUOTA_RECHECK_DELAY_MS))
      rateLimits = await requestOfficialRateLimits(headers)
    }

    return rateLimits !== undefined
      ? { rateLimits, canRefresh: true }
      : { canRefresh: true, issue: '官方接口未返回额度信息' }
  } catch (error) {
    return { canRefresh: true, issue: error instanceof Error ? error.message : String(error) }
  }
}

async function requestOfficialRateLimits(
  headers: Record<string, string>
): Promise<UsageSnapshot['rateLimits'] | undefined> {
  const response = await requestJson(OFFICIAL_CODEX_USAGE_URL, headers, OFFICIAL_QUOTA_TIMEOUT_MS)
  return parseOfficialRateLimits(response, new Date())
}

export function shouldRecheckOfficialRateLimits(
  officialRateLimits: UsageSnapshot['rateLimits'],
  localRateLimits: UsageSnapshot['rateLimits']
): boolean {
  const localById = new Map(localRateLimits.map((windowState) => [windowState.id, windowState]))
  return (
    officialRateLimits.length > 0 &&
    officialRateLimits.length === localRateLimits.length &&
    officialRateLimits.every((officialWindow) => {
      const localWindow = localById.get(officialWindow.id)
      return (
        officialWindow.usedPercent !== undefined &&
        localWindow?.usedPercent !== undefined &&
        officialWindow.usedPercent < localWindow.usedPercent
      )
    })
  )
}

function buildOfficialHeaders(credentials: {
  accessToken: string
  accountId?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    'User-Agent': 'codex-cli',
    Accept: 'application/json'
  }

  if (credentials.accountId) {
    headers['ChatGPT-Account-Id'] = credentials.accountId
  }

  return headers
}

// null 表示官方明确未返回计时窗口;undefined 表示接口不可用或窗口数据无效。
export function parseOfficialDispatchResetAts(
  response: unknown
): Record<string, number> | null | undefined {
  const body = getRecord(response)
  const rateLimit = getRecord(body?.rate_limit ?? body?.rateLimit)
  if (!rateLimit) {
    return undefined
  }

  const resetAts: Record<string, number> = {}
  for (const [id, windowState] of getOfficialWindowEntries(rateLimit)) {
    const resetAt = getNonNegativeNumber(windowState.reset_at ?? windowState.resetAt)
    if (resetAt === undefined) {
      return undefined
    }
    resetAts[id] = resetAt
  }

  return Object.keys(resetAts).length > 0 ? resetAts : null
}

export function areOfficialDispatchResetAtsStable(
  left: Record<string, number>,
  right: Record<string, number>,
  toleranceSeconds: number
): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        right[key] !== undefined && Math.abs(left[key] - right[key]) <= toleranceSeconds
    )
  )
}

// 窗口未激活时,官方接口的 reset_at 恒等于"当前时间 + 窗口全长"并随查询时间漂移;
// 激活后 reset_at 固定不变。调用方据此逐个判断官方实际返回的窗口是否启动计时。
export async function fetchOfficialDispatchResetAts(): Promise<
  Record<string, number> | null | undefined
> {
  const credentialLookup = await readOfficialCodexCredentials()
  if (!credentialLookup.credentials) {
    return undefined
  }

  try {
    const response = await requestJson(
      OFFICIAL_CODEX_USAGE_URL,
      buildOfficialHeaders(credentialLookup.credentials),
      OFFICIAL_QUOTA_TIMEOUT_MS
    )
    return parseOfficialDispatchResetAts(response)
  } catch {
    return undefined
  }
}

async function readOfficialCodexCredentials(): Promise<CredentialLookup> {
  const authPath = resolveCodexAuthPath()

  try {
    const content = await fs.readFile(authPath, 'utf8')
    const auth = parseJsonObject(content)
    if (!auth) {
      return { canRefresh: false, issue: 'Codex auth.json 不是有效 JSON' }
    }

    if (getString(auth.auth_mode ?? auth.authMode) !== 'chatgpt') {
      return { canRefresh: false, issue: 'Codex 当前不是 ChatGPT OAuth 模式' }
    }

    const tokens = getRecord(auth.tokens)
    const accessToken = getString(tokens?.access_token ?? tokens?.accessToken)
    if (!accessToken) {
      return { canRefresh: false, issue: 'Codex auth.json 缺少 access_token' }
    }

    return {
      canRefresh: true,
      credentials: {
        accessToken,
        accountId: getString(tokens?.account_id ?? tokens?.accountId)
      }
    }
  } catch {
    return { canRefresh: false, issue: '未找到 ~/.codex/auth.json' }
  }
}

function requestJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = []

      response.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })

      response.on('end', () => {
        const statusCode = response.statusCode ?? 0
        const body = Buffer.concat(chunks).toString('utf8')

        if (statusCode === 401 || statusCode === 403) {
          reject(new Error(`官方额度接口鉴权失败 HTTP ${statusCode}`))
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`官方额度接口返回 HTTP ${statusCode}`))
          return
        }

        try {
          resolve(body.trim().length > 0 ? JSON.parse(body) : {})
        } catch {
          reject(new Error('官方额度接口返回内容不是有效 JSON'))
        }
      })
    })

    request.setTimeout(Math.max(1000, timeoutMs), () => {
      request.destroy(new Error('官方额度接口请求超时'))
    })
    request.on('error', reject)
    request.end()
  })
}

export function parseOfficialRateLimits(
  response: unknown,
  observedAt: Date
): UsageSnapshot['rateLimits'] | undefined {
  const body = getRecord(response)
  const rateLimit = getRecord(body?.rate_limit ?? body?.rateLimit)
  if (!rateLimit) {
    return undefined
  }

  const windows = getOfficialWindowEntries(rateLimit)
    .map(([id, record]) => createOfficialRateLimitWindow(id, record, observedAt))
    .filter((windowState): windowState is RateLimitWindowSnapshot => windowState !== undefined)
  return windows.length > 0 ? windows : undefined
}

function createOfficialRateLimitWindow(
  id: string,
  record: Record<string, unknown> | undefined,
  observedAt: Date
): RateLimitWindowSnapshot | undefined {
  if (!record) {
    return undefined
  }

  const limitWindowSeconds = getNonNegativeNumber(
    record.limit_window_seconds ?? record.limitWindowSeconds
  )
  const usedPercent = getNonNegativeNumber(record.used_percent ?? record.usedPercent)
  const resetsAtMs = normalizeEpochMs(
    record.reset_at ?? record.resetAt ?? record.resets_at ?? record.resetsAt
  )

  if (usedPercent === undefined && resetsAtMs === undefined) {
    return undefined
  }

  return createRateLimitWindow(
    id,
    {
      windowMinutes: limitWindowSeconds !== undefined ? limitWindowSeconds / 60 : undefined,
      usedPercent,
      resetsAtMs
    },
    observedAt
  )
}

export function resolveCodexAuthPath(): string {
  return path.join(resolveCodexConfigDir(), 'auth.json')
}

function resolveCodexConfigDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome ? path.resolve(expandHome(codexHome)) : path.join(os.homedir(), '.codex')
}

function resolveSessionPaths(): string[] {
  const paths: string[] = []
  const codexHome = process.env.CODEX_HOME?.trim()

  if (codexHome) {
    paths.push(path.join(path.resolve(expandHome(codexHome)), SESSION_SUBDIR))
  }

  paths.push(path.join(os.homedir(), '.codex', SESSION_SUBDIR))
  return Array.from(new Set(paths))
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

async function collectJsonlFiles(root: string, maxEntries: number): Promise<JsonlFileEntry[]> {
  const entries: JsonlFileEntry[] = []
  await collectJsonlFilesInto(root, entries, maxEntries)
  return entries
}

async function collectJsonlFilesInto(
  root: string,
  entries: JsonlFileEntry[],
  maxEntries: number
): Promise<void> {
  if (entries.length >= maxEntries) {
    return
  }

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  const sortedDirents = dirents.sort((left, right) => {
    const leftDir = left.isDirectory() ? 1 : 0
    const rightDir = right.isDirectory() ? 1 : 0
    if (leftDir !== rightDir) {
      return rightDir - leftDir
    }
    return right.name.localeCompare(left.name)
  })

  for (const dirent of sortedDirents) {
    if (entries.length >= maxEntries) {
      return
    }

    const fullPath = path.join(root, dirent.name)
    if (dirent.isDirectory()) {
      await collectJsonlFilesInto(fullPath, entries, maxEntries)
      continue
    }

    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) {
      continue
    }

    try {
      const stat = await fs.stat(fullPath)
      entries.push({ filePath: fullPath, mtimeMs: stat.mtimeMs })
    } catch {
      continue
    }
  }
}

async function readLatestRateLimitSnapshot(
  filePath: string
): Promise<RateLimitSnapshot | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
    let latestSnapshot: RateLimitSnapshot | undefined

    for (const rawLine of lines) {
      const parsed = parseJsonObject(rawLine)
      if (!parsed) {
        continue
      }

      const entryType = getString(parsed.type)
      const payload = getRecord(parsed.payload)
      if (entryType !== 'event_msg' || !payload || getString(payload.type) !== 'token_count') {
        continue
      }

      const rateLimits = getRecord(payload.rate_limits)
      const timestamp = parseTimestamp(parsed)
      if (!rateLimits || !timestamp) {
        continue
      }

      latestSnapshot = {
        timestamp,
        primary: normalizeRateLimit(getRecord(rateLimits.primary)),
        secondary: normalizeRateLimit(getRecord(rateLimits.secondary))
      }
    }

    return latestSnapshot
  } catch {
    return undefined
  }
}

function normalizeRateLimit(record: Record<string, unknown> | undefined): RawRateLimit | undefined {
  if (!record) {
    return undefined
  }

  const windowMinutes = getNonNegativeNumber(record.window_minutes ?? record.windowMinutes)
  const usedPercent = getNonNegativeNumber(record.used_percent ?? record.usedPercent)
  const resetsInSeconds = getNonNegativeNumber(
    record.resets_in_seconds ?? record.reset_in_seconds ?? record.resetsInSeconds
  )
  const resetsAtMs = normalizeEpochMs(
    record.resets_at ?? record.reset_at ?? record.resetsAt ?? record.resetAt
  )

  if (
    windowMinutes === undefined &&
    usedPercent === undefined &&
    resetsInSeconds === undefined &&
    resetsAtMs === undefined
  ) {
    return undefined
  }

  return { windowMinutes, usedPercent, resetsInSeconds, resetsAtMs }
}

function toRateLimits(snapshot: RateLimitSnapshot | undefined): UsageSnapshot['rateLimits'] {
  if (!snapshot) {
    return []
  }

  return [
    snapshot.primary
      ? createRateLimitWindow('primary', snapshot.primary, snapshot.timestamp)
      : undefined,
    snapshot.secondary
      ? createRateLimitWindow('secondary', snapshot.secondary, snapshot.timestamp)
      : undefined
  ].filter((windowState): windowState is RateLimitWindowSnapshot => windowState !== undefined)
}

function createRateLimitWindow(
  id: string,
  raw: RawRateLimit,
  snapshotTime: Date
): RateLimitWindowSnapshot {
  const now = Date.now()
  const resetsAt =
    raw.resetsAtMs !== undefined
      ? new Date(raw.resetsAtMs)
      : raw.resetsInSeconds !== undefined
        ? new Date(snapshotTime.getTime() + raw.resetsInSeconds * 1000)
        : undefined
  const hasExpired = resetsAt !== undefined && resetsAt.getTime() <= now
  const usedPercent = hasExpired ? 0 : clampPercent(raw.usedPercent)
  const remainingPercent = usedPercent === undefined ? undefined : clampPercent(100 - usedPercent)
  const resetsInSeconds =
    resetsAt === undefined ? undefined : Math.max(0, Math.floor((resetsAt.getTime() - now) / 1000))

  return {
    id,
    label: resolveWindowLabel(id, raw.windowMinutes),
    windowMinutes: raw.windowMinutes,
    usedPercent,
    remainingPercent,
    resetsAt: resetsAt?.toISOString(),
    resetsInSeconds,
    observedAt: snapshotTime.toISOString()
  }
}

function resolveWindowLabel(
  id: string,
  windowMinutes: number | undefined
): string {
  if (windowMinutes === undefined) {
    return id
  }
  if (windowMinutes >= 1440) {
    return `${Math.round(windowMinutes / 1440)}d`
  }
  if (windowMinutes >= 60) {
    return `${Math.round(windowMinutes / 60)}h`
  }
  return `${Math.round(windowMinutes)}m`
}

function resolveSourceHost(rateLimitSource: RateLimitSource): string {
  if (rateLimitSource === 'official') {
    return 'chatgpt.com'
  }
  if (rateLimitSource === 'local') {
    return 'sessions JSONL'
  }
  return 'No data'
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    return getRecord(JSON.parse(value))
  } catch {
    return undefined
  }
}

function parseTimestamp(record: Record<string, unknown>): Date | undefined {
  const value = getString(record.timestamp ?? record.time ?? record.created_at ?? record.createdAt)
  if (!value) {
    return undefined
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function normalizeEpochMs(value: unknown): number | undefined {
  const raw = getNonNegativeNumber(value)
  if (raw === undefined) {
    return undefined
  }

  return raw >= 1_000_000_000_000 ? raw : raw * 1000
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined
  }

  return Math.max(0, Math.min(100, value))
}

function hasRateLimits(rateLimits: UsageSnapshot['rateLimits']): boolean {
  return rateLimits.length > 0
}

function getOfficialWindowEntries(
  rateLimit: Record<string, unknown>
): Array<[string, Record<string, unknown>]> {
  const windows = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(rateLimit)) {
    const suffix = key.endsWith('_window') ? '_window' : key.endsWith('Window') ? 'Window' : ''
    const windowState = suffix ? getRecord(value) : undefined
    if (windowState) {
      windows.set(key.slice(0, -suffix.length), windowState)
    }
  }
  return Array.from(windows.entries())
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function getNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : undefined
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
