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
    room = { clients: new Map(), anchorMs: Date.now(), skipHours: 0 }
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

  const client = { id: randomUUID(), ws, room, roomName, lastSeen: Date.now(), lastPoseAt: 0, pose: null, hands: [false, false], avatar: null }
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
    if (!validPose(message)) return
    if (now - client.lastPoseAt < 20) return
    client.pose = message.pose
    client.hands = message.hands
    client.avatar = message.avatar ?? null
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
    for (const client of room.clients.values()) {
      if (now - client.lastSeen > SILENCE_MS) {
        client.ws.terminate()
        continue
      }
      const peers = []
      for (const peer of room.clients.values()) {
        if (peer === client || !peer.pose) continue
        peers.push({ id: peer.id, pose: peer.pose, hands: peer.hands, avatar: peer.avatar })
      }
      // The clock rides on every snapshot rather than on welcome alone, so a
      // late joiner, a reconnect and a missed message all converge in one tick.
      send(client, { version: 1, type: 'snapshot', tick: serverTick, anchorMs: room.anchorMs, skipHours: room.skipHours, peers })
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
