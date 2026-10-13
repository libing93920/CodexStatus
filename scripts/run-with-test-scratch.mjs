/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const useElectron = args[0] === '--electron'
const scratchRoot = resolve(tmpdir())
const scratchPrefix = 'codex-status-test-'
if (useElectron) args.shift()

if (!args.length) {
  console.error('Usage: node scripts/run-with-test-scratch.mjs [--electron] <test args>')
  process.exitCode = 2
} else {
  let ownedScratchDirectory
  let child
  let receivedSignal
  const signalCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
  const signalHandlers = new Map(
    Object.keys(signalCodes).map((signal) => [
      signal,
      () => {
        receivedSignal = signal
        child?.kill(signal)
      }
    ])
  )

  for (const [signal, handler] of signalHandlers) process.once(signal, handler)

  try {
    const env = { ...process.env }
    if (!env.PI_SCRATCH_DIR) {
      ownedScratchDirectory = await mkdtemp(join(scratchRoot, scratchPrefix))
      env.PI_SCRATCH_DIR = ownedScratchDirectory
    }

    const executable = useElectron ? require('electron') : process.execPath
    const status = await new Promise((resolve, reject) => {
      child = spawn(executable, args, {
        cwd: process.cwd(),
        env,
        stdio: 'inherit',
        windowsHide: true
      })
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const signal = receivedSignal ?? status.signal
    process.exitCode = signal ? (signalCodes[signal] ?? 1) : (status.code ?? 1)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    if (ownedScratchDirectory) {
      try {
        await removeOwnedScratch(ownedScratchDirectory)
      } catch (error) {
        console.error(`Failed to remove test scratch directory: ${error}`)
        if (process.exitCode === 0) process.exitCode = 1
      }
    }
  }
}

async function removeOwnedScratch(directory) {
  const target = resolve(directory)
  if (dirname(target) !== scratchRoot || !basename(target).startsWith(scratchPrefix))
    throw new Error('Refusing to remove a directory outside the owned scratch root')
  await rm(target, { recursive: true, force: true })
}
