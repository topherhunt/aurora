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
    // `anchors`, `lured` and `crev`: the creatures someone is interacting with, see applyCreature.
    room = { clients: new Map(), anchorMs: Date.now(), skipHours: 0, boats: new Map(), loose: new Map(), gone: [], taken: [], rev: 0, anchors: new Map(), lured: new Map(), crev: 0 }
    rooms.set(name, room)
  }
  return room
}

function validRoom(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name)
}

// `avatar` names a file under public/creatures/ on every peer's client, so it
// is held to the creature id alphabet rather than relayed as free text.
// `scale` is the client's size against the world, absent at 1. `foot` is the
// world height of the client's feet, which a peer stands its body on instead
// of guessing; absent from a client too old to send it.
function validPose(message) {
  return message && message.type === 'pose' && Array.isArray(message.pose) && message.pose.length === 21 &&
    message.pose.every((n) => Number.isFinite(n)) && Array.isArray(message.hands) && message.hands.length === 2 &&
    message.hands.every((v) => typeof v === 'boolean') &&
    (message.avatar === undefined || (typeof message.avatar === 'string' && /^[a-z0-9-]{1,32}$/.test(message.avatar))) &&
    (message.foot === undefined || Number.isFinite(message.foot)) &&
    (message.scale === undefined || (Number.isFinite(message.scale) && message.scale >= 0.05 && message.scale <= 20))
}

// A pose may say where aboard a rowboat the client is (`aboard`: origin key,
// its head's place in the hull and its feet's height over the hull's datum)
// and, as the boat's authority, where the boat is (`boat`: origin, x, z, yaw,
// speed, yaw rate). Numbers only; the origin is the boat's tile key on every
// client. A client too old to send the fourth number of `aboard` sends three,
// and is relayed as it always was.
const finiteList = (v, n, or = n) => Array.isArray(v) && (v.length === n || v.length === or) &&
  v.every((x) => Number.isFinite(x)) && Number.isInteger(v[0])
function validBoats(message) {
  return (message.aboard === undefined || finiteList(message.aboard, 4, 3)) &&
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

// THE CREATURES SOMEONE IS INTERACTING WITH (_notes/creature-sync.md). Every
// creature lives on a plan each client derives alike from the room's clock,
// so the room keeps only the latest ANCHOR of each creature a player has
// drawn off its plan and, for the swarms, the latest LURED set of each bed:
// replaced on every write, never appended, delivered to a client once past
// the `crev` it last heard, the whole of it to a newcomer.
//
// An ANCHOR is [key, T, x, y, z, heading, phraseIndex, mode, by, ...layer
// fields], T in the room's world seconds (WorldClock.seconds: real seconds
// since anchorMs plus a minute a skipped hour); `by` is stamped here with
// the sender's id, and a sender never hears its own back. A LURED set is
// [bedKey, layer, by, indices]. Both fall out of the room once a chapter
// old: a client rejects anything before the creature's own chapter start
// (score.js chapterOf) exactly, so the relay need only bound its memory,
// and the caps forget what was written longest ago.
const CHAPTER_S = 600 // src/sim/score.js CHAPTER_S
const ROOM_ANCHORS_CAP = 256
const ROOM_LURED_CAP = 64
const ANCHOR_MAX_JSON = 256
const ANCHOR_FIELDS = 9
const ANCHOR_MAX_FIELDS = 24
const LURED_MAX_INDICES = 64
// A minute of clock slop between a client and the room; past it an anchor is from a clock this room does not keep.
const ANCHOR_AHEAD_S = 60
const validCreatureKey = (k) => typeof k === 'string' && /^[a-z0-9:,-]{1,32}$/.test(k)
const validWord = (w) => typeof w === 'string' && /^[a-z]{1,12}$/.test(w)
const roomSeconds = (room, now) => (now - room.anchorMs) / 1000 + room.skipHours * 60

function validAnchor(a, seconds) {
  if (!Array.isArray(a) || a.length < ANCHOR_FIELDS || a.length > ANCHOR_MAX_FIELDS) return false
  if (!validCreatureKey(a[0]) || !Number.isFinite(a[1]) || a[1] > seconds + ANCHOR_AHEAD_S || a[1] < seconds - CHAPTER_S) return false
  for (let i = 2; i < 6; i++) if (!Number.isFinite(a[i])) return false
  if (!Number.isInteger(a[6]) || !validWord(a[7]) || a[8] !== null) return false
  for (let i = ANCHOR_FIELDS; i < a.length; i++) if (a[i] !== null && !Number.isFinite(a[i])) return false
  return JSON.stringify(a).length <= ANCHOR_MAX_JSON
}

function validLured(s) {
  return Array.isArray(s) && s.length === 4 && validCreatureKey(s[0]) && validWord(s[1]) && s[2] === null &&
    Array.isArray(s[3]) && s[3].length <= LURED_MAX_INDICES && s[3].every((i) => Number.isInteger(i) && i >= 0)
}

/** True when the message was a well-formed anchor or lured set and is now the room's. */
function applyCreature(room, client, message, now) {
  const seconds = roomSeconds(room, now)
  if (message.type === 'anchor') {
    if (!validAnchor(message.anchor, seconds)) return false
    const anchor = message.anchor.slice()
    anchor[8] = client.id
    replaceCreature(room.anchors, anchor[0], { data: anchor, t: seconds, rev: ++room.crev }, ROOM_ANCHORS_CAP)
    return true
  }
  if (!validLured(message.set)) return false
  const set = message.set.slice()
  set[2] = client.id
  replaceCreature(room.lured, `${set[1]}/${set[0]}`, { data: set, t: seconds, rev: ++room.crev }, ROOM_LURED_CAP)
  return true
}

/** Sets `key` in `map`, a full map first forgetting the entry written longest ago. */
function replaceCreature(map, key, entry, cap) {
  if (map.size >= cap && !map.has(key)) {
    let oldest = null
    for (const [k, e] of map) if (oldest === null || e.t < map.get(oldest).t) oldest = k
    map.delete(oldest)
  }
  map.set(key, entry)
}

/** A chapter on, an anchor or a lured set is one every client rejects on its own; the room forgets it. */
function expireCreatures(room, now) {
  const before = roomSeconds(room, now) - CHAPTER_S
  for (const [k, e] of room.anchors) if (e.t < before) room.anchors.delete(k)
  for (const [k, e] of room.lured) if (e.t < before) room.lured.delete(k)
}

/** The anchors and lured sets written since this client last heard, none of them its own, or null when there are none. */
function creaturesFor(room, client) {
  const seen = client.seenCrev
  let out = null
  const anchors = []
  for (const e of room.anchors.values()) if (e.rev > seen && e.data[8] !== client.id) anchors.push(e.data)
  if (anchors.length) (out ??= {}).anchors = anchors
  const lured = []
  for (const e of room.lured.values()) if (e.rev > seen && e.data[2] !== client.id) lured.push(e.data)
  if (lured.length) (out ??= {}).lured = lured
  client.seenCrev = room.crev
  return out
}

// Bounded so a bad client cannot fling the room's sun across years.
function validSkip(message) {
  return message && message.type === 'skip' && Number.isInteger(message.hours) && Math.abs(message.hours) <= 24
}

// A saved game's hour: the skip count outright, to the minute, bounded like a
// skip. Only a client alone in its room may set it (the room's hour is then
// nobody else's); with company the message is dropped and the room's clock stands.
function validClock(message, room) {
  return message && message.type === 'clock' && Number.isFinite(message.skipHours) && Math.abs(message.skipHours - room.skipHours) <= 24
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
    id: randomUUID(), ws, room, roomName, lastSeen: Date.now(), lastPoseAt: 0, pose: null, hands: [false, false], avatar: null, scale: 1, foot: null, aboard: null,
    // What its hands hold, the rev that last changed, and how far through the room's things it has been told.
    held: new Array(HANDS).fill(null), heldRev: 0, seenRev: 0, takenSent: 0,
    // How far through the room's creatures it has been told.
    seenCrev: 0,
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
    if (validClock(message, room)) {
      if (room.clients.size === 1) room.skipHours = message.skipHours
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
    if (message && (message.type === 'anchor' || message.type === 'lured')) {
      if (applyCreature(room, client, message, now)) client.lastSeen = now
      return
    }
    if (!validPose(message) || !validBoats(message)) return
    if (now - client.lastPoseAt < 20) return
    client.pose = message.pose
    client.hands = message.hands
    client.avatar = message.avatar ?? null
    client.scale = message.scale ?? 1
    client.foot = message.foot ?? null
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
    expireCreatures(room, now)
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
        if (peer.scale !== 1) p.scale = peer.scale
        if (peer.foot !== null) p.foot = peer.foot
        if (peer.aboard) p.aboard = peer.aboard
        peers.push(p)
      }
      // The clock rides on every snapshot rather than on welcome alone, so a
      // late joiner, a reconnect and a missed message all converge in one tick.
      // So do the boats, each with its sample's age for the client to dead-reckon by.
      // The things and the creatures ride only when something changed since this client last heard.
      const snapshot = { version: 1, type: 'snapshot', tick: serverTick, anchorMs: room.anchorMs, skipHours: room.skipHours, peers, boats }
      const things = thingsFor(room, client)
      if (things) snapshot.things = things
      const creatures = creaturesFor(room, client)
      if (creatures) snapshot.creatures = creatures
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
