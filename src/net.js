const SEND_MS = 50
const INTERPOLATION_MS = 120
const MAX_SNAPSHOTS = 12
// The clock is measured against the relay's every PING_MS, the first PING_FAST of them FAST_MS apart, and the offset of the quickest round trip among the last PINGS is believed: a slow trip's half-way guess is the one that errs.
const PING_MS = 10_000
const FAST_MS = 500
const PING_FAST = 8
const PINGS = 12
// Diagnostic lines for the relay's log (server/src/main.js 'diag'), capped a page load; the clock is said once settled and again when it moves SAY_CLOCK_MS.
const DIAG_CAP = 200
const DIAG_MAX = 500
const SAY_CLOCK_MS = 100

function lerp(a, b, t) { return a + (b - a) * t }
function normalizeQuat(q) {
  const m = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return q.map((v) => v / m)
}
function slerp(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  if (dot < 0) { b = b.map((v) => -v); dot = -dot }
  if (dot > 0.9995) return normalizeQuat(a.map((v, i) => lerp(v, b[i], t)))
  const theta = Math.acos(Math.min(1, dot))
  const sin = Math.sin(theta)
  return a.map((v, i) => (Math.sin((1 - t) * theta) * v + Math.sin(t * theta) * b[i]) / sin)
}

// Exported for scripts/check-net.mjs: the Netplay that owns it needs a socket.
export function interpolate(a, b, t) {
  const pose = a.pose.map((v, i) => {
    const part = i % 7
    return part < 3 ? lerp(v, b.pose[i], t) : v
  })
  for (const start of [3, 10, 17]) {
    const q = slerp(a.pose.slice(start, start + 4), b.pose.slice(start, start + 4), t)
    pose.splice(start, 4, ...q)
  }
  const out = { pose, hands: t < 0.5 ? a.hands : b.hands }
  // The foot lerps with the head: taken from the newer sample alone it would step a walker down a slope every SEND_MS.
  if (Number.isFinite(b.foot)) out.foot = Number.isFinite(a.foot) ? lerp(a.foot, b.foot, t) : b.foot
  return out
}

export class Netplay {
  constructor({ room, onState, url }) {
    this.room = room || 'default'
    this.onState = onState
    this.url = url
    this.socket = null
    this.snapshots = []
    this.snapshotSerial = 0
    this.appliedSerial = 0
    this.peers = new Map()
    this.lastSend = -Infinity
    this.retry = 250
    this.closed = false
    // The creature id this client wears (see v2/render/avatar.js), set once the
    // roster loads and sent with every pose since the relay keeps only the
    // latest message per client.
    this.avatar = null
    // Her size against the world (DESIGN.md §30, half in a glade), sent with
    // every pose so a peer draws her body at it; 1 is left off the wire.
    this.scale = 1
    // Whether she sleeps (v2/vitals.js); the relay moves the room's clock only when every client does.
    this.asleep = false
    // The room's world clock as the relay last stated it, `{ anchorMs,
    // skipHours }` for WorldClock.sync, or null until the first snapshot.
    this.time = null
    // The relay's Date.now() less this machine's, from the pings (_pong); two
    // devices' own clocks can stand seconds apart, and the room's time must not.
    this.offsetMs = 0
    this.pings = []
    this.pingTimer = null
    // Diag lines sent this page load, and the clock offset last said.
    this.diags = 0
    this.clockSaid = null
    // This client's id as the relay named it on welcome; what a boat's
    // authority is decided by (v2/boats.js). Null until then.
    this.id = null
    // The relay's latest state of every boat anyone has moved, `[origin, x, z,
    // yaw, v, w, ageMs]` each, and a serial that steps once per snapshot so
    // boats.js applies each list once. Not interpolated: a sample is
    // dead-reckoned from its age.
    this.boats = null
    this.boatsSerial = 0
    // The relay's changes to the things in hands and on the ground since the
    // last snapshot that carried any (v2/hands-net.js drains it), and how many
    // welcomes have come: a new one is a new client id on the relay, which
    // knows nothing of what this client holds.
    this.things = []
    this.welcomes = 0
    // The relay's changes to the creatures someone is interacting with since
    // the last snapshot that carried any, `{ anchors, lured }` blocks
    // (v2/creature-net.js drains it).
    this.creatures = []
    // The flares peers have shot since the last drain, `[...flare, ageMs]` each (v2/render/flares.js fromWire).
    this.flares = []
    this.connect()
  }

  connect() {
    if (this.closed) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const base = this.url || `${protocol}//${location.host}/ws`
    const socket = new WebSocket(`${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(this.room)}`)
    this.socket = socket
    socket.addEventListener('open', () => {
      this.retry = 250
      let sent = 0
      const ping = () => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ version: 1, type: 'ping', t: Date.now() }))
        this.pingTimer = setTimeout(ping, ++sent < PING_FAST ? FAST_MS : PING_MS)
      }
      clearTimeout(this.pingTimer)
      ping()
    })
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.version === 1 && message.type === 'welcome' && typeof message.id === 'string') { this.id = message.id; this.welcomes++; return }
      if (message.version === 1 && message.type === 'pong') { this._pong(message, Date.now()); return }
      if (message.version !== 1 || message.type !== 'snapshot' || !Array.isArray(message.peers)) return
      const receivedAt = performance.now()
      if (Array.isArray(message.boats)) {
        this.boats = message.boats.filter((b) => Array.isArray(b) && b.length === 7 && b.every((n) => Number.isFinite(n)))
        this.boatsSerial++
      }
      if (message.things && typeof message.things === 'object') this.things.push(message.things)
      if (message.creatures && typeof message.creatures === 'object') this.creatures.push(message.creatures)
      if (Array.isArray(message.flares)) this.flares.push(...message.flares)
      if (Number.isFinite(message.anchorMs) && Number.isFinite(message.skipHours)) {
        this.time = { anchorMs: message.anchorMs, skipHours: message.skipHours, offsetMs: this.offsetMs }
      }
      const peers = message.peers.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.pose) && p.pose.length === 21)
      this.snapshots.push({ receivedAt, peers, serial: ++this.snapshotSerial })
      if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift()
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.closed) return
      this.socket = null
      setTimeout(() => this.connect(), this.retry)
      this.retry = Math.min(8000, this.retry * 2)
    })
  }

  /**
   * `boats`, when given, is `{ aboard, boat }` from Boats.netState: her place
   * aboard a boat and, as its authority, the boat's state; each null when not.
   * `foot` is the world height of her feet, which a peer stands its body on
   * rather than reading its own ground under a guess at where her feet are --
   * see v2/render/avatar-rig.js. Aboard a boat it is overridden by `aboard`,
   * which carries the same height in the hull's frame so it survives the
   * INTERPOLATION_MS the boat travels under her.
   */
  sendPose(pose, hands, now = performance.now(), boats = null, foot = null) {
    if (now - this.lastSend < SEND_MS || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.lastSend = now
    const { avatar, scale } = this
    const message = { version: 1, type: 'pose', pose, hands }
    if (avatar) message.avatar = avatar
    if (scale !== 1) message.scale = scale
    if (this.asleep) message.asleep = true
    if (Number.isFinite(foot)) message.foot = Math.round(foot * 1000) / 1000
    if (boats && boats.aboard) message.aboard = boats.aboard
    if (boats && boats.boat) message.boat = boats.boat
    this.socket.send(JSON.stringify(message))
  }

  // A change to what this client holds or has let go of or taken (v2/hands-net.js
  // shapes it). False when there is no relay to tell, so the caller keeps it.
  sendThing(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ version: 1, ...message }))
    return true
  }

  // An anchor for a creature this client is the authority for, or a lured
  // set for a bed (v2/creature-net.js). False when there is no relay to
  // tell; the caller drops it, since the next says everything this one did.
  sendAnchor(anchor) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ version: 1, type: 'anchor', anchor }))
    return true
  }

  sendLured(set) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ version: 1, type: 'lured', set }))
    return true
  }

  // A flare she shot, as flares.js toWire has it. False when there is no relay to tell; the room never hears of it.
  sendFlare(flare) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ version: 1, type: 'flare', flare }))
    return true
  }

  // Ask the relay to move the room's clock. False when there is no relay to
  // ask, so the caller can skip locally instead.
  sendSkip(hours) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ version: 1, type: 'skip', hours }))
    return true
  }

  // Ask the relay to set the room's skip count outright, for a saved game's
  // hour; it grants this only to a client alone in the room. False with no
  // relay to ask.
  sendClock(skipHours) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify({ version: 1, type: 'clock', skipHours }))
    return true
  }

  update(now = performance.now()) {
    const target = now - INTERPOLATION_MS
    while (this.snapshots.length > 1 && this.snapshots[1].receivedAt <= target) this.snapshots.shift()
    const older = this.snapshots[0]
    const newer = this.snapshots[1] || older
    if (older) {
      const span = Math.max(1, (newer?.receivedAt ?? older.receivedAt) - older.receivedAt)
      const t = Math.max(0, Math.min(1, (target - older.receivedAt) / span))
      const incoming = new Map((older.peers || []).map((peer) => [peer.id, peer]))
      for (const peer of newer?.peers || []) {
        const old = incoming.get(peer.id)
        incoming.set(peer.id, old ? { ...peer, ...interpolate(old, peer, t) } : peer)
      }
      const isNewSnapshot = older.serial > this.appliedSerial
      for (const peer of incoming.values()) {
        const previous = this.peers.get(peer.id)
        this.peers.set(peer.id, { ...peer, seenAt: isNewSnapshot ? now : (previous?.seenAt ?? now) })
      }
      if (isNewSnapshot) this.appliedSerial = older.serial
    }
    for (const [id, peer] of this.peers) {
      peer.alpha = Math.max(0, 1 - Math.max(0, now - peer.seenAt - 300) / 1500)
      if (now - peer.seenAt > 10_000) this.peers.delete(id)
    }
    this.onState?.([...this.peers.values()])
  }

  /** A ping come back at local `now`: the relay stamped it `ms` half a round trip ago, give or take the trip's asymmetry. */
  _pong({ t, ms }, now) {
    if (!Number.isFinite(t) || !Number.isFinite(ms) || now < t) return
    this.pings.push({ rtt: now - t, offset: ms + (now - t) / 2 - now })
    if (this.pings.length > PINGS) this.pings.shift()
    let best = this.pings[0]
    for (const p of this.pings) if (p.rtt < best.rtt) best = p
    this.offsetMs = best.offset
    if (this.time) this.time.offsetMs = best.offset
    if (this.pings.length >= PING_FAST && (this.clockSaid === null || Math.abs(best.offset - this.clockSaid) > SAY_CLOCK_MS)) {
      this.clockSaid = best.offset
      this.diag(`clock offset ${Math.round(best.offset)} ms, rtt ${best.rtt} ms`)
    }
  }

  /** A line for the relay's log, tagged there with this client's address and device; dropped while the socket is down. */
  diag(text) {
    if (this.diags >= DIAG_CAP || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.diags++
    this.socket.send(JSON.stringify({ version: 1, type: 'diag', text: String(text).slice(0, DIAG_MAX) }))
  }

  close() {
    this.closed = true
    clearTimeout(this.pingTimer)
    this.socket?.close()
  }
}
