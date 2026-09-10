const SEND_MS = 50
const INTERPOLATION_MS = 120
const MAX_SNAPSHOTS = 12

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

function interpolate(a, b, t) {
  const pose = a.pose.map((v, i) => {
    const part = i % 7
    return part < 3 ? lerp(v, b.pose[i], t) : v
  })
  for (const start of [3, 10, 17]) {
    const q = slerp(a.pose.slice(start, start + 4), b.pose.slice(start, start + 4), t)
    pose.splice(start, 4, ...q)
  }
  return { pose, hands: t < 0.5 ? a.hands : b.hands }
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
    this.connect()
  }

  connect() {
    if (this.closed) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const base = this.url || `${protocol}//${location.host}/ws`
    const socket = new WebSocket(`${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(this.room)}`)
    this.socket = socket
    socket.addEventListener('open', () => { this.retry = 250 })
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.version !== 1 || message.type !== 'snapshot' || !Array.isArray(message.peers)) return
      const receivedAt = performance.now()
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

  sendPose(pose, hands, now = performance.now()) {
    if (now - this.lastSend < SEND_MS || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.lastSend = now
    const { avatar } = this
    this.socket.send(JSON.stringify({ version: 1, type: 'pose', pose, hands, ...(avatar ? { avatar } : {}) }))
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

  close() {
    this.closed = true
    this.socket?.close()
  }
}
