import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3004)
const ROOM_CAP = Math.max(2, Number(process.env.ROOM_CAP || 8))
const TICK_MS = 50
const SILENCE_MS = 45_000
const MAX_PAYLOAD = 4096

const rooms = new Map()
let serverTick = 0

// A room owns the world clock as one anchor and one skip count: every client
// derives the hour from `anchorMs` locally (WorldClock.tick), so the first
// joiner spawns at CLOCK.startHour and everyone after sees the room's hour.
function roomFor(name) {
  let room = rooms.get(name)
  if (!room) {
    // `boats`: origin key -> the last state any client sent for a rowboat it
    // was moving, so a joiner finds the boats where they were left.
    // `loose`, `gone`, `taken` and `rev`: the things in the room, see applyThing.
    room = { clients: new Map(), anchorMs: Date.now(), skipHours: 0, boats: new Map(), loose: new Map(), gone: [], taken: [], rev: 0 }
    rooms.set(name, room)
  }
  return room
}

function validRoom(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name)
}

// `avatar` names a file under public/creatures/ on every peer's client, so it
// is held to the creature id alphabet rather than relayed as free text.
function validPose(message) {
  return message && message.type === 'pose' && Array.isArray(message.pose) && message.pose.length === 21 &&
    message.pose.every((n) => Number.isFinite(n)) && Array.isArray(message.hands) && message.hands.length === 2 &&
    message.hands.every((v) => typeof v === 'boolean') &&
    (message.avatar === undefined || (typeof message.avatar === 'string' && /^[a-z0-9-]{1,32}$/.test(message.avatar)))
}

// A pose may say where aboard a rowboat the client is (`aboard`: origin key
// and its head's place in the hull) and, as the boat's authority, where the
// boat is (`boat`: origin, x, z, yaw, speed, yaw rate). Numbers only; the
// origin is the boat's tile key on every client.
const finiteList = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x)) && Number.isInteger(v[0])
function validBoats(message) {
  return (message.aboard === undefined || finiteList(message.aboard, 3)) &&
    (message.boat === undefined || finiteList(message.boat, 6))
}
const ROOM_BOATS_CAP = 32

// THE THINGS IN HANDS AND ON THE GROUND. What each client holds, what lies
// loose where someone let it go, and where anyone has pulled something out
// of a bed, so nobody else's bed grows it back. Every change steps the room's
// `rev`, and a client gets the changes past the rev it last saw in its next
// snapshot and nothing between changes: what anyone holds is a slot the
// client sends once, not with every pose.
//
// A SLOT is what hands.js packs for the backpack: kind, name, size, scale,
// tint, stowable, the instanced attributes, and a source's own scalars (a
// variant); held to a small alphabet and to SLOT_MAX_JSON bytes since every
// client draws it. A loose thing's POSE is [x, y, z, qx, qy, qz, qw] and its
// STATE 0 (still), 1 (afloat) or 2 (in motion: let go, and the taker sends
// where it came to rest). The taken log is [key, x, z] entries as the taken
// registry keys them, kept to TAKEN_CAP with the oldest forgotten.
const SLOT_MAX_JSON = 512
const SLOT_MAX_ATTRS = 8
const ROOM_LOOSE_CAP = 24
const ROOM_GONE_CAP = 64
const TAKEN_CAP = 4096
const TAKEN_TRIM = 1024
const TAKE_MAX_PER_MESSAGE = 100
const HANDS = 3
const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))
const validKey = (k) => typeof k === 'string' && /^[a-z0-9:-]{1,24}$/.test(k)
const validLooseId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-z]{1,8}$/.test(id)

function validSlot(slot) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false
  if (!validKey(slot.kind) || typeof slot.name !== 'string' || slot.name.length > 32) return false
  if (!(Number.isFinite(slot.size) && slot.size > 0) || !finite3(slot.scale) || typeof slot.stowable !== 'boolean') return false
  if (slot.color !== null && !finite3(slot.color)) return false
  if (!slot.attrs || typeof slot.attrs !== 'object' || Array.isArray(slot.attrs)) return false
  const attrs = Object.entries(slot.attrs)
  if (attrs.length > SLOT_MAX_ATTRS) return false
  for (const [name, values] of attrs) if (!/^[A-Za-z]{1,24}$/.test(name) || !Array.isArray(values) || values.length > SLOT_MAX_ATTRS || !values.every((n) => Number.isFinite(n))) return false
  for (const [key, value] of Object.entries(slot)) {
    if (['kind', 'name', 'size', 'scale', 'stowable', 'color', 'attrs'].includes(key)) continue
    if (!/^[A-Za-z]{1,24}$/.test(key)) return false
    if (!(Number.isFinite(value) || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 32))) return false
  }
  return JSON.stringify(slot).length <= SLOT_MAX_JSON
}
const validPose7 = (p) => Array.isArray(p) && p.length === 7 && p.every((n) => Number.isFinite(n))

function validThing(message) {
  if (!message || typeof message !== 'object') return false
  switch (message.type) {
    case 'hold': return Number.isInteger(message.hand) && message.hand >= 0 && message.hand < HANDS && (message.slot === null || validSlot(message.slot))
    case 'loose': return validLooseId(message.id) && validSlot(message.slot) && validPose7(message.pose) && [0, 1, 2].includes(message.state)
    case 'lift': return validLooseId(message.id)
    case 'take': return Array.isArray(message.list) && message.list.length > 0 && message.list.length <= TAKE_MAX_PER_MESSAGE &&
      message.list.every((e) => Array.isArray(e) && e.length === 3 && validKey(e[0]) && Number.isFinite(e[1]) && Number.isFinite(e[2]))
    default: return false
  }
}

function applyThing(room, client, message, now) {
  const rev = ++room.rev
  if (message.type === 'hold') {
    client.held[message.hand] = message.slot
    client.heldRev = rev
  } else if (message.type === 'loose') {
    // An id the room has forgotten stays forgotten: a thing settling with its owner after a peer lifted it is not put back.
    if (!room.loose.has(message.id) && room.gone.some(([id]) => id === message.id)) return
    if (!room.loose.has(message.id) && room.loose.size >= ROOM_LOOSE_CAP) {
      // Full: the thing lying there longest is forgotten.
      let oldest = null
      for (const [id, l] of room.loose) if (oldest === null || l.at < room.loose.get(oldest).at) oldest = id
      forgetLoose(room, oldest, rev)
    }
    const was = room.loose.get(message.id)
    room.loose.set(message.id, { slot: message.slot, pose: message.pose, state: message.state, by: client.id, rev, at: was ? was.at : now })
  } else if (message.type === 'lift') {
    if (room.loose.has(message.id)) forgetLoose(room, message.id, rev)
  } else if (message.type === 'take') {
    for (const e of message.list) room.taken.push(e)
    if (room.taken.length > TAKEN_CAP) {
      room.taken.splice(0, TAKEN_TRIM)
      for (const c of room.clients.values()) c.takenSent = Math.max(0, c.takenSent - TAKEN_TRIM)
    }
  }
}

function forgetLoose(room, id, rev) {
  room.loose.delete(id)
  room.gone.push([id, rev])
  if (room.gone.length > ROOM_GONE_CAP) room.gone.shift()
}

/** The changes past what this client has seen, or null when there are none. */
function thingsFor(room, client) {
  const seen = client.seenRev
  let out = null
  const held = []
  for (const peer of room.clients.values()) if (peer !== client && peer.heldRev > seen) held.push([peer.id, ...peer.held])
  if (held.length) (out ??= {}).held = held
  const loose = []
  for (const [id, l] of room.loose) if (l.rev > seen) loose.push([id, l.slot, l.pose, l.state, l.by])
  if (loose.length) (out ??= {}).loose = loose
  // A client that has heard nothing yet has nothing to forget.
  const gone = []
  if (seen > 0) for (const [id, rev] of room.gone) if (rev > seen) gone.push(id)
  if (gone.length) (out ??= {}).gone = gone
  if (room.taken.length > client.takenSent) {
    (out ??= {}).take = room.taken.slice(client.takenSent)
    client.takenSent = room.taken.length
  }
  client.seenRev = room.rev
  return out
}

// Bounded so a bad client cannot fling the room's sun across years.
function validSkip(message) {
  return message && message.type === 'skip' && Number.isInteger(message.hours) && Math.abs(message.hours) <= 24
}

function leave(client) {
  if (!client.room) return
  client.room.clients.delete(client.id)
  if (!client.room.clients.size) rooms.delete(client.roomName)
  client.room = null
}

function send(client, message) {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message))
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, service: 'aurora-relay', rooms: rooms.size }))
    return
  }
  res.writeHead(404)
  res.end('not found\n')
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD })

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const roomName = url.searchParams.get('room') || 'default'
  if (!validRoom(roomName)) {
    ws.close(1008, 'invalid room')
    return
  }
  const room = roomFor(roomName)
  if (room.clients.size >= ROOM_CAP) {
    ws.close(1013, 'room full')
    return
  }

  const client = {
    id: randomUUID(), ws, room, roomName, lastSeen: Date.now(), lastPoseAt: 0, pose: null, hands: [false, false], avatar: null, aboard: null,
    // What its hands hold, the rev that last changed, and how far through the room's things it has been told.
    held: new Array(HANDS).fill(null), heldRev: 0, seenRev: 0, takenSent: 0,
  }
  room.clients.set(client.id, client)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true; client.lastSeen = Date.now() })
  ws.on('message', (raw) => {
    let message
    try { message = JSON.parse(raw.toString()) } catch { return }
    const now = Date.now()
    if (validSkip(message)) {
      room.skipHours += message.hours
      client.lastSeen = now
      return
    }
    if (message && ['hold', 'loose', 'lift', 'take'].includes(message.type)) {
      if (validThing(message)) {
        applyThing(room, client, message, now)
        client.lastSeen = now
      }
      return
    }
    if (!validPose(message) || !validBoats(message)) return
    if (now - client.lastPoseAt < 20) return
    client.pose = message.pose
    client.hands = message.hands
    client.avatar = message.avatar ?? null
    client.aboard = message.aboard ?? null
    if (message.boat) {
      if (room.boats.size >= ROOM_BOATS_CAP && !room.boats.has(message.boat[0])) {
        // Full: the boat left alone longest makes room.
        let oldest = null
        for (const [origin, b] of room.boats) if (oldest === null || b.at < room.boats.get(oldest).at) oldest = origin
        room.boats.delete(oldest)
      }
      room.boats.set(message.boat[0], { state: message.boat, at: now })
    }
    client.lastPoseAt = now
    client.lastSeen = now
  })
  ws.on('close', () => leave(client))
  ws.on('error', () => leave(client))
  send(client, { version: 1, type: 'welcome', id: client.id, room: roomName, tick: serverTick })
})

setInterval(() => {
  const now = Date.now()
  serverTick++
  for (const room of rooms.values()) {
    const boats = []
    for (const [origin, b] of room.boats) boats.push([origin, ...b.state.slice(1), now - b.at])
    for (const client of room.clients.values()) {
      if (now - client.lastSeen > SILENCE_MS) {
        client.ws.terminate()
        continue
      }
      const peers = []
      for (const peer of room.clients.values()) {
        if (peer === client || !peer.pose) continue
        const p = { id: peer.id, pose: peer.pose, hands: peer.hands, avatar: peer.avatar }
        if (peer.aboard) p.aboard = peer.aboard
        peers.push(p)
      }
      // The clock rides on every snapshot rather than on welcome alone, so a
      // late joiner, a reconnect and a missed message all converge in one tick.
      // So do the boats, each with its sample's age for the client to dead-reckon by.
      // The things ride only when something changed since this client last heard.
      const snapshot = { version: 1, type: 'snapshot', tick: serverTick, anchorMs: room.anchorMs, skipHours: room.skipHours, peers, boats }
      const things = thingsFor(room, client)
      if (things) snapshot.things = things
      send(client, snapshot)
    }
  }
}, TICK_MS)

setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) client.terminate()
    client.isAlive = false
    client.ping()
  }
}, 25_000)

httpServer.listen(PORT, HOST, () => console.log(`aurora relay listening on ${HOST}:${PORT}`))
