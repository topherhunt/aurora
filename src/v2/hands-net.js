import THREE from '../three-instance.js'
import { HOLD_OFFSET } from './hands.js'

// ---------------------------------------------------------------------------
// The room's things: what her hands (hands.js) tell the relay, and what the
// relay tells her of everyone else's hands and the ground between them
// (server/src/main.js, "the things in hands and on the ground").
//
// OUT: every event the hands emit -- a hold, a loose thing let go or come to
// rest, a lift -- goes to the relay once, in order, as it happens; every
// entry the taken registry gains (a bed's take) goes as a `take` list, up to
// TAKE_PER_MESSAGE at a time. Nothing goes between events. When the relay
// names this client afresh -- the first welcome, or one after a dropped
// socket -- it knows nothing of her, so the queue is rebuilt from what is
// true now: what each hand holds, every loose thing, every taken entry.
//
// IN: the relay sends the changes since this client last heard, and only
// then. A peer's held slot becomes a copy in the pools, placed each frame at
// that peer's hand: the grip as the pose says, when the peer holds a
// controller in it; the body's wrist otherwise, which is the desktop's hand
// too. A loose thing appears, eases or goes as hands.js has it. A take
// evicts the thing from the bed that grew it here, or, not grown here yet,
// keeps it out of the registry so it never is.
// ---------------------------------------------------------------------------

const HAND_INDEX = { left: 0, right: 1, desk: 2 }
// Pose parts on the wire: the head at 0, the grips at 7 and 14 (net.js).
const GRIP_AT = [7, 14]
const TAKE_PER_MESSAGE = 100
// Events kept for a relay that is not answering; past this the oldest go, and the next welcome rebuilds the lot anyway.
const QUEUE_MAX = 512
// The wire carries positions and slots to this many decimals: within the registry's 0.05 m match, and a tint's step on screen.
const DECIMALS = 3
const round = (v) => Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS
const roundAll = (v) => (Array.isArray(v) ? v.map(roundAll) : typeof v === 'number' ? round(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundAll(x)])) : v)

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _o = new THREE.Vector3()

export class HandsNet {
  /**
   * `hands` is the Hands, `netplay` the Netplay, `avatars` the PeerAvatars
   * (for a peer's wrist), `taken` the registry the beds consult.
   */
  constructor(hands, netplay, avatars, taken) {
    if (!hands || typeof hands.netHold !== 'function') throw new Error('HandsNet needs the Hands')
    if (!netplay || typeof netplay.sendThing !== 'function') throw new Error('HandsNet needs the Netplay')
    if (!avatars || typeof avatars.handAt !== 'function') throw new Error('HandsNet needs the PeerAvatars')
    if (!taken || typeof taken.add !== 'function') throw new Error('HandsNet needs the taken registry')
    this.hands = hands
    this.netplay = netplay
    this.avatars = avatars
    this.taken = taken
    this.queue = []
    this.takeQueue = []
    // Loose things heard of before their source landed its asset, tried again each frame.
    this.pending = []
    this.welcomes = 0
    // While a peer's take is being applied here, the registry's adds are its, not hers.
    this.applying = false
    hands.sync = (event) => this._push(this._wire(event))
    taken.onAdd = (kind, x, z) => { if (!this.applying) this.takeQueue.push([kind, round(x), round(z)]) }
    // For the panel.
    this.sent = 0
    this.heard = 0
  }

  /** A hands event as the relay takes it: the hand by index, the numbers rounded. */
  _wire(event) {
    if (event.type === 'hold') {
      const hand = HAND_INDEX[event.hand]
      if (hand === undefined) throw new Error(`HandsNet: no wire index for hand ${event.hand}`)
      return { type: 'hold', hand, slot: event.slot === null ? null : roundAll(event.slot) }
    }
    if (event.type === 'loose') return { type: 'loose', id: event.id, slot: roundAll(event.slot), pose: event.pose.map(round), state: event.state }
    if (event.type === 'lift') return { type: 'lift', id: event.id }
    throw new Error(`HandsNet: unknown hands event ${event.type}`)
  }

  _push(message) {
    this.queue.push(message)
    while (this.queue.length > QUEUE_MAX) this.queue.shift()
  }

  /** The queue as the relay, knowing nothing of her, needs it: every hand, every loose thing, every taken entry. */
  _rebuild() {
    this.queue.length = 0
    this.takeQueue.length = 0
    for (const key of this.hands.hands.keys()) {
      const rec = this.hands.holding(key)
      this._push(this._wire({ type: 'hold', hand: key, slot: rec === null ? null : this.hands.pack(rec) }))
    }
    for (const event of this.hands.looseEvents()) this._push(this._wire(event))
    for (const [kind, list] of this.taken.byKind) for (let i = 0; i < list.length; i += 2) this.takeQueue.push([kind, round(list[i]), round(list[i + 1])])
  }

  update() {
    const net = this.netplay
    if (net.welcomes !== this.welcomes && net.id) {
      this.welcomes = net.welcomes
      this.hands.tag = net.id.slice(0, 8)
      this._rebuild()
    }
    while (this.queue.length && net.sendThing(this.queue[0])) { this.queue.shift(); this.sent++ }
    while (this.queue.length === 0 && this.takeQueue.length) {
      const list = this.takeQueue.slice(0, TAKE_PER_MESSAGE)
      if (!net.sendThing({ type: 'take', list })) break
      this.takeQueue.splice(0, list.length)
      this.sent++
    }
    for (const block of net.things) this._apply(block)
    net.things.length = 0
    if (this.pending.length) this.pending = this.pending.filter((l) => !this.hands.netLoose(l[0], l[1], l[2], l[3]))
    for (const id of this.hands.peerHeld.keys()) if (!net.peers.has(id)) this.hands.netPeerGone(id)
    this._placePeers()
  }

  _apply(block) {
    this.heard++
    const me = this.netplay.id
    for (const [id, ...slots] of block.held ?? []) {
      if (id === me) continue
      for (let h = 0; h < 3; h++) this.hands.netHold(id, h, slots[h] ?? null)
    }
    for (const l of block.loose ?? []) {
      if (l[4] === me) continue
      if (!this.hands.netLoose(l[0], l[1], l[2], l[3])) this.pending.push(l)
    }
    for (const id of block.gone ?? []) this.hands.netLift(id)
    for (const [key, x, z] of block.take ?? []) {
      if (this.taken.has(key, x, z)) continue
      this.applying = true
      try {
        let evicted = false
        for (const src of this.hands.sources) if (typeof src.evict === 'function' && src.evict(key, x, z)) { evicted = true; break }
        if (!evicted) this.taken.add(key, x, z)
      } finally {
        this.applying = false
      }
    }
  }

  /** Each peer's copies to that peer's hands this frame. */
  _placePeers() {
    for (const [id, held] of this.hands.peerHeld) {
      const peer = this.netplay.peers.get(id)
      if (!peer) continue
      for (let h = 0; h < 3; h++) {
        if (!held[h]?.item) continue
        if (h < 2 && peer.hands[h]) {
          const at = GRIP_AT[h]
          _q.set(peer.pose[at + 3], peer.pose[at + 4], peer.pose[at + 5], peer.pose[at + 6])
          _o.copy(HOLD_OFFSET).applyQuaternion(_q)
          this.hands.placePeer(id, h, peer.pose[at] + _o.x, peer.pose[at + 1] + _o.y, peer.pose[at + 2] + _o.z, _q)
        } else if (this.avatars.handAt(id, h === 2 ? 1 : h, _p, _q)) {
          this.hands.placePeer(id, h, _p.x, _p.y, _p.z, _q)
        }
      }
    }
  }

  get stats() {
    return { queued: this.queue.length + this.takeQueue.length, pending: this.pending.length, sent: this.sent, heard: this.heard }
  }
}
