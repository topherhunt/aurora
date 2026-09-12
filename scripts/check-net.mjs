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
  const nextSnapshot = (ws, accept) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), 1000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'snapshot' && message.peers.length && accept(message.peers[0])) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(message.peers[0])
      }
    }
    ws.addEventListener('message', onMessage)
  })
  // An avatar id that is not a creature id is dropped with its whole message,
  // so the first pose the peer ever sees is the well-formed one after it.
  first.send(JSON.stringify({ version: 1, type: 'pose', pose: pose.map((v) => -v), hands: [true, false], avatar: '../etc' }))
  await wait(30)
  first.send(JSON.stringify({ version: 1, type: 'pose', pose, hands: [true, false], avatar: 'blacksmith' }))
  const peer = await nextSnapshot(second, () => true)
  if (peer.pose.join(',') !== pose.join(',') || peer.hands[0] !== true) throw new Error('pose round-trip mismatch')
  if (peer.avatar !== 'blacksmith') throw new Error(`avatar round-trip mismatch: got ${JSON.stringify(peer.avatar)}`)
  // Without the field the relay says null, which the client reads as "dress by id hash".
  await wait(30)
  first.send(JSON.stringify({ version: 1, type: 'pose', pose, hands: [false, false] }))
  const bare = await nextSnapshot(second, (p) => p.hands[0] === false)
  if (bare.avatar !== null) throw new Error(`avatar should be null when unsent, got ${JSON.stringify(bare.avatar)}`)
  // The room clock: every snapshot carries the room's anchor and skip count,
  // a skip from one client reaches the other, and an unbounded skip is dropped.
  const nextClock = (ws, accept) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('clock snapshot timeout')), 1000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'snapshot' && accept(message)) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(message)
      }
    }
    ws.addEventListener('message', onMessage)
  })
  const startedAt = Date.now()
  const clock = await nextClock(second, () => true)
  if (!Number.isFinite(clock.anchorMs) || clock.anchorMs > startedAt || startedAt - clock.anchorMs > 5000) throw new Error(`anchorMs should be the room's creation time, got ${clock.anchorMs} at ${startedAt}`)
  if (clock.skipHours !== 0) throw new Error(`a fresh room has no skips, got ${clock.skipHours}`)
  first.send(JSON.stringify({ version: 1, type: 'skip', hours: 1000 }))
  first.send(JSON.stringify({ version: 1, type: 'skip', hours: 6.5 }))
  first.send(JSON.stringify({ version: 1, type: 'skip', hours: 6 }))
  const skipped = await nextClock(second, (m) => m.skipHours !== 0)
  if (skipped.skipHours !== 6) throw new Error(`only the bounded integer skip should land, got ${skipped.skipHours}`)
  if (skipped.anchorMs !== clock.anchorMs) throw new Error('a skip must not move the anchor')
  console.log('net relay check: OK (pose, hands, avatar round-trip; malformed avatar dropped; room clock anchor and skip relayed)')
  first.close()
  second.close()
} finally {
  server.kill('SIGTERM')
}
