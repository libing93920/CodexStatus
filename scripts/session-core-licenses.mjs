/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const LICENSE_NAME = /^(licen[sc]e|copying|notice|copyright)([._-]|$)/i
const LICENSE_DIRECTORIES = ['', 'licenses', 'LICENSES', 'zstd']
const METADATA_LIMIT_BYTES = 16 * 1024 * 1024

export function writeSessionCoreLicenses({ root, manifest }) {
  const compiler = run('rustc', ['-vV'], root)
  const host = /^host: (.+)$/m.exec(compiler)?.[1]
  if (!host) throw new Error('无法识别 Rust 构建平台')
  const metadata = JSON.parse(
    run(
      'cargo',
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        manifest,
        '--filter-platform',
        host
      ],
      root
    )
  )
  const packages = metadata.packages
    .filter((item) => item.source)
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
    )
  const sections = [
    'Third-party notices for the compiled session-core helper.\n' +
      'CC Switch attribution is provided separately in cc-switch-LICENSE.'
  ]
  for (const item of packages) {
    const directory = path.dirname(item.manifest_path)
    const files = licenseFiles(directory, item.license_file)
    sections.push(
      `\n${'='.repeat(72)}\n${item.name} ${item.version}\nLicense: ${item.license ?? 'See license text'}\n` +
        files
          .map(
            (file) => `\n--- ${path.relative(directory, file)} ---\n${readFileSync(file, 'utf8')}`
          )
          .join('\n')
    )
  }
  const destination = path.join(root, 'resources', 'licenses')
  mkdirSync(destination, { recursive: true })
  writeFileSync(path.join(destination, 'session-core-THIRD-PARTY-NOTICES.txt'), sections.join('\n'))
}

function licenseFiles(directory, declared) {
  const files = new Set()
  if (declared) files.add(path.resolve(directory, declared))
  for (const child of LICENSE_DIRECTORIES) {
    const candidate = path.join(directory, child)
    if (!existsSync(candidate)) continue
    for (const entry of readdirSync(candidate, { withFileTypes: true })) {
      if (entry.isFile() && LICENSE_NAME.test(entry.name))
        files.add(path.join(candidate, entry.name))
    }
  }
  return [...files].sort()
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: METADATA_LIMIT_BYTES
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr}`)
  return result.stdout
}
