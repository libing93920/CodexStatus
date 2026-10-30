import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const MAX_FRAME_BYTES = 1024 * 1024
const WSL_TIMEOUT_MS = 10_000

export interface HermesSqliteScan {
  sessions: Record<string, unknown>[]
  first: Record<string, unknown>[]
  last: Record<string, unknown>[]
}

export function hermesWslTarget(
  databasePath: string
): { distro: string; linuxPath: string } | undefined {
  const rest = databasePath.startsWith('\\\\?\\UNC\\')
    ? databasePath.slice('\\\\?\\UNC\\'.length)
    : databasePath.startsWith('\\\\')
      ? databasePath.slice(2)
      : undefined
  if (!rest) return undefined
  const [host, distro, ...parts] = rest.split('\\')
  if (!host || !distro || !['wsl.localhost', 'wsl$'].includes(host.toLowerCase())) return undefined
  if (
    distro.startsWith('-') ||
    parts.length === 0 ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    return undefined
  return { distro, linuxPath: `/${parts.join('/')}` }
}

export async function readHermesWslScan(
  databasePath: string,
  signal?: AbortSignal
): Promise<HermesSqliteScan> {
  const target = hermesWslTarget(databasePath)
  if (!target) throw new Error('Hermes WSL database path is invalid')
  if (process.platform !== 'win32') throw new Error('Hermes WSL reader requires Windows')
  signal?.throwIfAborted()
  const child = spawn(
    'wsl.exe',
    [
      '--distribution',
      target.distro,
      '--exec',
      'timeout',
      '8s',
      'python3',
      '-I',
      '-c',
      WSL_READER,
      target.linuxPath,
      JSON.stringify({ operation: 'scan' })
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as const }
  )
  return new Promise<HermesSqliteScan>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stderrBytes = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, WSL_TIMEOUT_MS)
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 4096) return
      const part = Buffer.from(chunk).subarray(0, 4096 - stderrBytes)
      stderr.push(part)
      stderrBytes += part.length
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`Failed to start Hermes WSL reader: ${error.message}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        signal?.throwIfAborted()
        if (timedOut) throw new Error('Hermes WSL reader timed out')
        const stderrText = Buffer.concat(stderr).toString('utf8').trim()
        if (code !== 0)
          throw new Error(`Hermes WSL read failed (python3 is required): ${stderrText}`)
        resolve(decodeFrames(Buffer.concat(stdout)))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function decodeFrames(source: Buffer): HermesSqliteScan {
  const decoder = new StringDecoder('utf8')
  const text = decoder.write(source) + decoder.end()
  const frames: string[] = []
  let start = 0
  while (true) {
    const newline = text.indexOf('\n', start)
    if (newline < 0) break
    const frame = text.slice(start, newline)
    if (Buffer.byteLength(frame, 'utf8') + 1 > MAX_FRAME_BYTES)
      throw new Error('Hermes WSL frame exceeds its limit')
    const decoded: unknown = JSON.parse(frame)
    if (typeof decoded !== 'string') throw new Error('Hermes WSL frame is not a JSON string')
    frames.push(decoded)
    start = newline + 1
  }
  if (start !== text.length) throw new Error('Hermes WSL frame is incomplete')
  const response: unknown = JSON.parse(frames.join(''))
  if (!response || typeof response !== 'object' || Array.isArray(response))
    throw new Error('Invalid Hermes WSL session response')
  const data = response as Record<string, unknown>
  if (!Array.isArray(data.sessions)) throw new Error('Invalid Hermes WSL session response')
  return {
    sessions: records(data.sessions),
    first: records(data.first),
    last: records(data.last)
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (record): record is Record<string, unknown> =>
          record !== null && typeof record === 'object' && !Array.isArray(record)
      )
    : []
}

const WSL_READER = `
import json, pathlib, sqlite3, sys
sys.stdout.reconfigure(encoding="utf-8")
FRAME_CHARS = 128 * 1024
request = json.loads(sys.argv[2])
connection = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True, timeout=2.0, isolation_level=None)
connection.row_factory = sqlite3.Row
connection.execute("PRAGMA query_only=ON")
connection.execute("BEGIN")
def rows(sql):
    result = []
    for row in connection.execute(sql):
        result.append({key: (None if isinstance(row[key], bytes) else row[key]) for key in row.keys()})
    return result
def visible():
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(messages)")}
    if "active" not in columns:
        return ""
    return " AND (active=1 OR compacted=1)" if "compacted" in columns else " AND active=1"
if request["operation"] != "scan":
    raise ValueError("Unsupported Hermes read operation")
sessions = rows("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 500")
edge_query = "SELECT m.session_id,m.content FROM messages m JOIN (SELECT session_id,{pick}(id) edge_id FROM messages WHERE {condition}{filter} AND session_id IN (SELECT id FROM sessions ORDER BY rowid DESC LIMIT 500) GROUP BY session_id) f ON m.id=f.edge_id"
if connection.execute("PRAGMA table_info(messages)").fetchone():
    first = rows(edge_query.format(pick="MIN", condition="role='user'", filter=visible()))
    last = rows(edge_query.format(pick="MAX", condition="role IN ('user','assistant') AND content IS NOT NULL AND content!=''", filter=visible()))
else:
    first, last = [], []
response = {"sessions": sessions, "first": first, "last": last}
connection.rollback()
connection.close()
for part in json.JSONEncoder(ensure_ascii=False).iterencode(response):
    for start in range(0, len(part), FRAME_CHARS):
        print(json.dumps(part[start:start + FRAME_CHARS], ensure_ascii=False))
`
