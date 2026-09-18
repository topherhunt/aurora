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
    room = { clients: new Map(), anchorMs: Date.now(), skipHours: 0, boats: new Map() }
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

  const client = { id: randomUUID(), ws, room, roomName, lastSeen: Date.now(), lastPoseAt: 0, pose: null, hands: [false, false], avatar: null, aboard: null }
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
    if (!validPose(message) || !validBoats(message)) return
    if (now - client.lastPoseAt < 20) return
    client.pose = message.pose
    client.hands = message.hands
    client.avatar = message.avatar ?? null
    client.aboard = message.aboard ?? null
    if (message.boat && (room.boats.size < ROOM_BOATS_CAP || room.boats.has(message.boat[0]))) {
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
      send(client, { version: 1, type: 'snapshot', tick: serverTick, anchorMs: room.anchorMs, skipHours: room.skipHours, peers, boats })
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
