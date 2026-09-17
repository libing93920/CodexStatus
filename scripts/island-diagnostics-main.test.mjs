/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createIslandDiagWriter,
  islandInteractiveDiagnostic,
  receiveIslandDiagnostics
} from '../src/main/services/island-diagnostics.ts'
import { setDiagDirectory } from '../src/main/services/diag-log.ts'

test('灵动岛主进程 writer 将慢盘待写批次限制为 2 并报告丢弃量', async (context) => {
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = '1'
  context.after(() => {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  })

  const messages = []
  const resolvers = []
  const write = (message) =>
    new Promise((resolveWrite) => {
      messages.push(message)
      resolvers.push(resolveWrite)
    })
  const writer = createIslandDiagWriter(write)

  const submitted = 10_000
  for (let sequence = 1; sequence <= submitted; sequence++) {
    writer.submit('renderer', batch(sequence))
  }
  const immediateWrites = messages.length
  assert.equal(immediateWrites, 2)

  resolvers[0]()
  await delay(0)
  await delay(1_100)
  assert.equal(messages.length, 3)

  const payloads = messages.map((message) => JSON.parse(message.slice('island-diag '.length)))
  const report = payloads.find((payload) => payload.events.length === 0)
  assert.ok(report)
  assert.equal(report.source, 'main')
  assert.equal(report.sinkDropped, submitted - 2)
  assert.equal(report.dropped, 0)
  console.log(
    JSON.stringify({
      writerSubmittedBatches: submitted,
      writerImmediateWrites: immediateWrites,
      writerTotalWrites: messages.length,
      writerDroppedEvents: report.sinkDropped
    })
  )

  resolvers[1]()
  resolvers[2]()
})

test('快磁盘下每秒最多写入 40 批，超限仍报告丢弃', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const messages = []
  const writer = createIslandDiagWriter(async (message) => {
    messages.push(message)
  })
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = '1'
  context.after(() => {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  })
  for (let sequence = 1; sequence <= 100; sequence++) {
    writer.submit('renderer', batch(sequence))
    await new Promise(setImmediate)
  }
  assert.equal(messages.length, 40)
  context.mock.timers.tick(1000)
  assert.equal(messages.length, 41)
  assert.equal(JSON.parse(messages.at(-1).slice('island-diag '.length)).sinkDropped, 60)
})

test('非法 sender 的灵动岛诊断 IPC 被拒绝', async (context) => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), 'codex-status-island-diag-sender-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = '1'
  context.after(() => {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  })

  setDiagDirectory(directory)
  receiveIslandDiagnostics(12, 13, batch(1))
  await delay(100)
  await assert.rejects(fs.access(join(directory, 'diag', 'diag.log')))
})

test('诊断开关关闭时合法 sender 不写入，开启后保留批次时间和序号', async (context) => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), 'codex-status-island-diag-valid-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  context.after(() => {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  })

  setDiagDirectory(directory)
  process.env.CODEX_STATUS_DIAG = '0'
  receiveIslandDiagnostics(12, 12, batch(9))
  const logPath = join(directory, 'diag', 'diag.log')
  await delay(100)
  await assert.rejects(fs.access(logPath))

  process.env.CODEX_STATUS_DIAG = '1'
  receiveIslandDiagnostics(12, 12, batch(9))
  await waitForFile(logPath)
  const line = (await fs.readFile(logPath, 'utf8')).trim().split(/\r?\n/).at(-1)
  const marker = 'island-diag '
  const markerIndex = line.indexOf(marker)
  assert.ok(markerIndex >= 0)
  const payload = JSON.parse(line.slice(markerIndex + marker.length))
  assert.equal(payload.source, 'renderer')
  assert.equal(typeof payload.receivedAt, 'number')
  assert.equal(payload.events[0].at, 9)
  assert.equal(payload.events[0].seq, 9)
})

test('islandInteractive 关联字段只保留 instance 和 request', () => {
  const previousEnabled = process.env.CODEX_STATUS_DIAG
  process.env.CODEX_STATUS_DIAG = '1'
  try {
    assert.deepEqual(
      islandInteractiveDiagnostic({
        instance: 'renderer-1',
        request: 7,
        reason: 'secret-context',
        extra: 'discard-me'
      }),
      { peerInstance: 'renderer-1', request: 7 }
    )
    assert.deepEqual(islandInteractiveDiagnostic({ instance: 'bad.instance', request: 1 }), {})
    assert.deepEqual(islandInteractiveDiagnostic({ instance: 'renderer-1', request: 0 }), {})
    assert.deepEqual(islandInteractiveDiagnostic({ instance: 'renderer-1', request: 1.5 }), {})
  } finally {
    if (previousEnabled === undefined) delete process.env.CODEX_STATUS_DIAG
    else process.env.CODEX_STATUS_DIAG = previousEnabled
  }
})

function batch(sequence) {
  return {
    events: [
      {
        instance: 'renderer-1',
        seq: sequence,
        at: sequence,
        mono: sequence,
        event: 'ready',
        fields: {}
      }
    ],
    dropped: 0
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.access(path)
      return
    } catch {
      await delay(25)
    }
  }
  assert.fail(`diagnostic file was not written: ${path}`)
}
