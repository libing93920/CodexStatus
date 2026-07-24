import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RateLimitSource, RateLimitWindowSnapshot, UsageSnapshot } from '../../shared/capsule'
import { fetchRadarBestPick } from './radar'

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
const OFFICIAL_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const OFFICIAL_QUOTA_TIMEOUT_MS = 8000
const OFFICIAL_QUOTA_RECHECK_DELAY_MS = 1000
const RESET_CREDIT_TIMEOUT_MS = 8000
// 重置卡到期前多久开始重新拉取下一张(秒)
const RESET_CREDIT_REFRESH_BEFORE_EXPIRY_SECONDS = 60
// 无可用重置卡/请求失败时,多久内不再重试(毫秒)
const RESET_CREDIT_EMPTY_RETRY_MS = 24 * 60 * 60 * 1000
const RESET_CREDIT_ERROR_RETRY_MS = 30 * 60 * 1000
const FILE_SCAN_LIMIT = 80

interface ResetCreditCacheEntry {
  value: UsageSnapshot['resetCredit']
  fetchedAtMs: number
  state: 'ok' | 'empty' | 'error'
}

let resetCreditCache: ResetCreditCacheEntry | undefined

export function invalidateQuotaCaches(): void {
  resetCreditCache = undefined
}

interface CollectOptions {
  iqThreshold?: number
}

export async function collectUsageSnapshot(
  options: CollectOptions = {}
): Promise<UsageSnapshot> {
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
  let resetCredit: UsageSnapshot['resetCredit']
  let bestModelPick: UsageSnapshot['bestModelPick']

  const credentialLookup = await readOfficialCodexCredentials()
  if (credentialLookup.credentials) {
    const headers = buildOfficialHeaders(credentialLookup.credentials)
    const lookup = await fetchOfficialRateLimits(headers, localRateLimits)
    if (lookup.rateLimits !== undefined) {
      rateLimits = lookup.rateLimits
      rateLimitSource = 'official'
    } else {
      officialIssue = lookup.issue
    }
    resetCredit = await getResetCreditWithCache(headers)
  } else {
    officialIssue = credentialLookup.issue ?? '未找到 Codex OAuth 凭据'
  }

  bestModelPick = await fetchRadarBestPick(options.iqThreshold).catch(() => undefined)

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
    canRefresh: credentialLookup?.canRefresh ?? true,
    generatedAt: new Date().toISOString(),
    rateLimits,
    rateLimitSource,
    sourceHost: resolveSourceHost(rateLimitSource),
    officialIssue,
    resetCredit,
    bestModelPick,
    issues: Array.from(new Set(issues)).slice(0, 6),
    filesScanned: limitedFiles.length,
    sessionsPath: checkedPaths.find((candidate) => !missingPaths.includes(candidate))
  }
}

async function fetchOfficialRateLimits(
  headers: Record<string, string>,
  localRateLimits: UsageSnapshot['rateLimits']
): Promise<{ rateLimits?: UsageSnapshot['rateLimits']; issue?: string }> {
  try {
    let rateLimits = await requestOfficialRateLimits(headers)
    if (rateLimits && shouldRecheckOfficialRateLimits(rateLimits, localRateLimits)) {
      await new Promise((resolve) => setTimeout(resolve, OFFICIAL_QUOTA_RECHECK_DELAY_MS))
      rateLimits = await requestOfficialRateLimits(headers)
    }
    return rateLimits !== undefined
      ? { rateLimits }
      : { issue: '官方接口未返回额度信息' }
  } catch (error) {
    return { issue: error instanceof Error ? error.message : String(error) }
  }
}

async function requestOfficialRateLimits(
  headers: Record<string, string>
): Promise<UsageSnapshot['rateLimits'] | undefined> {
  const response = await requestJson(OFFICIAL_CODEX_USAGE_URL, headers, OFFICIAL_QUOTA_TIMEOUT_MS)
  return parseOfficialRateLimits(response, new Date())
}

// 独立端点获取重置卡到期时间:
// GET /backend-api/wham/rate-limit-reset-credits
// 响应: { credits: [{ expires_at: "YYYY-MM-DDTHH:mm:ssZ" (RFC3339字符串) }, ...], available_count?: number }
// 取最近(最早)到期的一张返回;无可用卡或接口失败返回 undefined。
async function fetchOfficialResetCredit(
  headers: Record<string, string>
): Promise<UsageSnapshot['resetCredit'] | undefined> {
  const resetHeaders = {
    ...headers,
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/'
  }
  const response = await requestJson(
    OFFICIAL_RESET_CREDITS_URL,
    resetHeaders,
    RESET_CREDIT_TIMEOUT_MS
  )
  return parseResetCredits(response)
}

function parseResetCredits(response: unknown): UsageSnapshot['resetCredit'] | undefined {
  const body = getRecord(response)
  const credits = Array.isArray(body?.credits) ? body.credits : undefined
  const availableCount = getNonNegativeNumber(body?.available_count ?? body?.availableCount)
  if (!credits || credits.length === 0) {
    // 没详情但有可用数量也无法显示到期时间
    return undefined
  }
  let earliestMs: number | undefined
  for (const entry of credits) {
    const record = getRecord(entry)
    if (!record) continue
    const expiresRaw = record.expires_at ?? record.expiresAt
    const expiresAt =
      typeof expiresRaw === 'string'
        ? parseRfc3339(expiresRaw)
        : typeof expiresRaw === 'number'
          ? normalizeEpochMs(expiresRaw)
          : undefined
    if (expiresAt === undefined) continue
    if (earliestMs === undefined || expiresAt < earliestMs) {
      earliestMs = expiresAt
    }
  }
  if (earliestMs === undefined) {
    return undefined
  }
  return {
    availableCount: availableCount ?? 1,
    expiresAt: new Date(earliestMs).toISOString()
  }
}

function parseRfc3339(value: string): number | undefined {
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : undefined
}

// 重置卡缓存:
// - 有卡且未到快到期时间,直接返回缓存,不打接口
// - 卡已到期或快到期,重新拉取下一张
// - 上次结果是空(无卡),24h 内不重试
// - 上次请求失败,30min 内用错误缓存(不显示)
async function getResetCreditWithCache(
  headers: Record<string, string>
): Promise<UsageSnapshot['resetCredit'] | undefined> {
  const now = Date.now()
  if (resetCreditCache) {
    const age = now - resetCreditCache.fetchedAtMs
    if (resetCreditCache.state === 'ok' && resetCreditCache.value) {
      const expiresAtMs = resetCreditCache.value.expiresAt
        ? Date.parse(resetCreditCache.value.expiresAt)
        : NaN
      const expired =
        Number.isFinite(expiresAtMs) &&
        expiresAtMs - now < RESET_CREDIT_REFRESH_BEFORE_EXPIRY_SECONDS * 1000
      if (!expired) {
        // 卡未到刷新窗口,直接用缓存
        return resetCreditCache.value
      }
    } else if (resetCreditCache.state === 'empty') {
      if (age < RESET_CREDIT_EMPTY_RETRY_MS) {
        return undefined
      }
    } else if (resetCreditCache.state === 'error') {
      if (age < RESET_CREDIT_ERROR_RETRY_MS) {
        return undefined
      }
    }
  }

  try {
    const value = await fetchOfficialResetCredit(headers)
    if (value) {
      resetCreditCache = { value, fetchedAtMs: Date.now(), state: 'ok' }
      return value
    }
    resetCreditCache = { value: undefined, fetchedAtMs: Date.now(), state: 'empty' }
    return undefined
  } catch (error) {
    resetCreditCache = { value: undefined, fetchedAtMs: Date.now(), state: 'error' }
    // 请求失败时,如果之前有缓存值(比如卡还没到期),继续显示旧值比什么都不显示好
    return undefined
  }
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

async function requestJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  // 优先用 Electron net 模块(Chromium 网络栈,自动走系统代理、HTTP/2、会话);
  // 测试环境下 electron 不可用,回落到全局 fetch(不发送真实请求也不会被测试调用到)。
  const fetchImpl = resolveFetchImplementation()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow'
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error(`官方额度接口鉴权失败 HTTP ${response.status}`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`官方额度接口返回 HTTP ${response.status}`)
    }
    const text = await response.text()
    return text.trim().length > 0 ? JSON.parse(text) : {}
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('官方额度接口请求超时')
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

function resolveFetchImplementation(): typeof fetch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron') | undefined
    const netFetch = electron?.net?.fetch
    if (electron && typeof netFetch === 'function') {
      return netFetch.bind(electron.net) as unknown as typeof fetch
    }
  } catch {
    // not in electron environment (e.g. tests)
  }
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis)
  }
  throw new Error('No HTTP client available')
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
): RateLimitWindowSnapshot | undefined {  if (!record) {
    return undefined
  }

  const limitWindowSeconds = getNonNegativeNumber(
    record.limit_window_seconds ?? record.limitWindowSeconds
  )
  const usedPercent = getNonNegativeNumber(record.used_percent ?? record.usedPercent)
  const resetsAtMs = normalizeEpochMs(
    record.reset_at ?? record.resetAt ?? record.resets_at ?? record.resetsAt
  )
  const resetsInSeconds = getNonNegativeNumber(
    record.resets_in_seconds ??
      record.reset_in_seconds ??
      record.resetsInSeconds ??
      record.resetInSeconds
  )

  if (usedPercent === undefined && resetsAtMs === undefined && resetsInSeconds === undefined) {
    return undefined
  }

  return createRateLimitWindow(
    id,
    {
      windowMinutes: limitWindowSeconds !== undefined ? limitWindowSeconds / 60 : undefined,
      usedPercent,
      resetsAtMs,
      resetsInSeconds
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
