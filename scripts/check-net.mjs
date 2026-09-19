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
  // The things in hands and on the ground: a hold, a loose thing, a lift and a
  // take each reach the other client once, as a `things` block on the next
  // snapshot, and a snapshot between changes carries no block at all.
  const nextThings = (ws, accept, ms = 1000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('things timeout')), ms)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'snapshot' && message.things && accept(message.things)) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(message.things)
      }
    }
    ws.addEventListener('message', onMessage)
  })
  const slot = { kind: 'mushroom', name: 'fly agaric', variant: 2, size: 0.21, color: [0.8, 0.2, 0.1], scale: [1.2, 1.2, 1.2], stowable: true, attrs: {} }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  // A slot past the alphabet is dropped with its message: the good hold after it is the first the peer hears.
  first.send(JSON.stringify({ version: 1, type: 'hold', hand: 0, slot: { ...slot, name: 'x'.repeat(40) } }))
  first.send(JSON.stringify({ version: 1, type: 'hold', hand: 0, slot }))
  const held = await nextThings(second, (t) => t.held)
  if (held.held.length !== 1 || held.held[0].length !== 4 || !same(held.held[0][1], slot) || held.held[0][2] !== null || held.held[0][3] !== null) throw new Error(`hold round-trip mismatch: ${JSON.stringify(held.held)}`)
  const firstId = held.held[0][0]
  if (held.loose || held.gone || held.take) throw new Error(`a hold alone should carry nothing else: ${JSON.stringify(held)}`)
  // Nothing changed: the next snapshots carry no things.
  await wait(120)
  const idle = await nextClock(second, () => true)
  if ('things' in idle) throw new Error(`an idle room should send no things, got ${JSON.stringify(idle.things)}`)
  // She also hears nothing of her own hand.
  await wait(120)
  const mine = await nextClock(first, () => true)
  if ('things' in mine) throw new Error(`the holder should not hear her own hold back, got ${JSON.stringify(mine.things)}`)
  const pose7 = [1, 2, 3, 0, 0, 0, 1]
  first.send(JSON.stringify({ version: 1, type: 'loose', id: 'deadbeef-1', slot, pose: pose7, state: 2 }))
  const loose = await nextThings(second, (t) => t.loose)
  if (loose.held) throw new Error('a loose thing should not resend the hold')
  if (loose.loose.length !== 1 || !same(loose.loose[0], ['deadbeef-1', slot, pose7, 2, firstId])) throw new Error(`loose round-trip mismatch: ${JSON.stringify(loose.loose)}`)
  // The same id again is an update: the rest pose, once.
  const rest = [1, 0.5, 3, 0, 0.7, 0, 0.7]
  first.send(JSON.stringify({ version: 1, type: 'loose', id: 'deadbeef-1', slot, pose: rest, state: 0 }))
  const rested = await nextThings(second, (t) => t.loose)
  if (rested.loose.length !== 1 || rested.loose[0][3] !== 0 || !same(rested.loose[0][2], rest)) throw new Error(`loose update mismatch: ${JSON.stringify(rested.loose)}`)
  first.send(JSON.stringify({ version: 1, type: 'take', list: [['mushroom', 1.5, 2.5], ['spider:rock3', -4, 8]] }))
  first.send(JSON.stringify({ version: 1, type: 'take', list: [['mushroom', 1.5, 'nan']] }))
  const took = await nextThings(second, (t) => t.take)
  if (!same(took.take, [['mushroom', 1.5, 2.5], ['spider:rock3', -4, 8]])) throw new Error(`take round-trip mismatch: ${JSON.stringify(took.take)}`)
  first.send(JSON.stringify({ version: 1, type: 'lift', id: 'deadbeef-1' }))
  const gone = await nextThings(second, (t) => t.gone)
  if (!same(gone.gone, ['deadbeef-1']) || gone.loose) throw new Error(`lift round-trip mismatch: ${JSON.stringify(gone)}`)
  // The lifted id settling late with its owner is not put back.
  first.send(JSON.stringify({ version: 1, type: 'loose', id: 'deadbeef-1', slot, pose: rest, state: 0 }))
  await wait(120)
  const late = await nextClock(second, () => true)
  if ('things' in late) throw new Error(`a lifted id should stay gone, got ${JSON.stringify(late.things)}`)
  // A newcomer hears the room as it stands: the hand, the taken log, not the lifted thing.
  const third = await open()
  const fresh = await nextThings(third, () => true)
  if (!fresh.held || fresh.held.length !== 1 || fresh.held[0][0] !== firstId || !same(fresh.held[0][1], slot)) throw new Error(`newcomer should hear the held slot: ${JSON.stringify(fresh.held)}`)
  if (!same(fresh.take, [['mushroom', 1.5, 2.5], ['spider:rock3', -4, 8]])) throw new Error(`newcomer should hear the taken log: ${JSON.stringify(fresh.take)}`)
  if (fresh.loose || fresh.gone) throw new Error(`newcomer should hear nothing of a lifted thing: ${JSON.stringify(fresh)}`)
  third.close()
  // The ground holds 24 loose things; the twenty-fifth forgets the one lying there longest, and the room hears it go.
  for (let i = 0; i < 25; i++) {
    first.send(JSON.stringify({ version: 1, type: 'loose', id: `deadbeef-c${i.toString(36)}`, slot, pose: pose7, state: 0 }))
    if (i === 0) await wait(20)
  }
  const ids = new Set()
  let forgotten = null
  const until = Date.now() + 1500
  while (!forgotten && Date.now() < until) {
    const t = await nextThings(second, () => true, 1500)
    for (const l of t.loose ?? []) ids.add(l[0])
    for (const id of t.gone ?? []) { ids.delete(id); forgotten = id }
  }
  if (forgotten !== 'deadbeef-c0') throw new Error(`the oldest loose thing should be forgotten at the cap, got ${forgotten}`)
  if (ids.size !== 24 || ids.has('deadbeef-c0')) throw new Error(`24 loose things should remain, got ${ids.size}`)
  console.log('net relay check: OK (pose, hands, avatar round-trip; malformed avatar dropped; room clock anchor and skip relayed; hold, loose, lift and take relayed once, nothing between changes, a newcomer hears the room as it stands, the loose cap forgets the oldest)')
  first.close()
  second.close()
} finally {
  server.kill('SIGTERM')
}
