import { spawn } from 'node:child_process'

const WebSocket = globalThis.WebSocket
if (!WebSocket) throw new Error('check-net requires a Node version with the WebSocket client (Node 22+)')

const port = 34127
const server = spawn(process.execPath, ['server/src/main.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  await wait(150)
  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=check-net`)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const first = await open()
  const second = await open()
  const pose = Array.from({ length: 21 }, (_, i) => (i % 7 === 6 ? 1 : i / 10))
  first.send(JSON.stringify({ version: 1, type: 'pose', pose, hands: [true, false] }))
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), 1000)
    second.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'snapshot' && message.peers.length) {
        clearTimeout(timer)
        resolve(message)
      }
    })
  })
  const peer = snapshot.peers[0]
  if (peer.pose.join(',') !== pose.join(',') || peer.hands[0] !== true) throw new Error('pose round-trip mismatch')
  console.log('net relay check: OK')
  first.close()
  second.close()
} finally {
  server.kill('SIGTERM')
}
