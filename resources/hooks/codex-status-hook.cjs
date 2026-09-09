const fs = require('node:fs')
const net = require('node:net')

const MAX_INPUT_BYTES = 128 * 1024
const CONNECT_TIMEOUT_MS = 500
const descriptorPath = process.argv[2]
let input = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  if (input.length > MAX_INPUT_BYTES) process.stdin.destroy()
})

process.stdin.once('end', () => {
  let event
  try {
    event = JSON.parse(input.toString('utf8'))
  } catch {
    return
  }
  if (event?.hook_event_name === 'PermissionRequest') process.stdout.write('{}\n')
  report(event)
})

function report(event) {
  let endpoint
  try {
    endpoint = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
  } catch {
    return
  }
  if (typeof endpoint?.pipePath !== 'string' || typeof endpoint?.nonce !== 'string') return
  const socket = net.createConnection(endpoint.pipePath)
  const timeout = setTimeout(() => socket.destroy(), CONNECT_TIMEOUT_MS)
  socket.once('connect', () => {
    socket.end(`${JSON.stringify({ nonce: endpoint.nonce, event })}\n`)
  })
  socket.once('close', () => clearTimeout(timeout))
  socket.once('error', () => clearTimeout(timeout))
}
