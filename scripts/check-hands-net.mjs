// Node-side gate for the room's things (src/v2/hands-net.js): what her hands
// tell the relay and what the relay tells her of everyone else's. Run against
// the real Hands with a stub source, a stub Netplay that records what is sent
// and hands back what is heard, and a stub PeerAvatars with a wrist to place
// a desktop peer's copy at.
//
//   node scripts/check-hands-net.mjs
//
// What can go wrong without throwing: a hold or a drop that never leaves; one
// sent twice, or every frame; a thing let go before the relay answered that
// the room never hears of; a reconnect that leaves the relay with the old
// hands; a peer's copy drawn at her own hand, or nowhere; a peer's take that
// leaves the thing growing here, or that comes back to the relay as hers; a
// thing whose source has not landed lost rather than tried again; a queue
// that grows without bound while the socket is down.

import * as THREE from 'three'
import { Hands, ROLL_MAX_S, HOLD_OFFSET } from '../src/v2/hands.js'
import { HandsNet } from '../src/v2/hands-net.js'
import { Taken } from '../src/v2/taken.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const walk = { heightAt: () => 0, normalAt: (x, z, eps, out = { x: 0, y: 1, z: 0 }) => { out.x = 0; out.y = 1; out.z = 0; return out } }
const water = { levelAt: () => null }
const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.1, 0)
geo.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(4).fill(1), 1))
const material = new THREE.MeshBasicMaterial()

// A bed of mushrooms at fixed spots that records its takes in the registry it is given, like the real ones.
class Source {
  constructor(things, taken) { this.things = things; this.taken = taken; this.landed = true; this.evicted = [] }
  dress() { return this.landed ? { geometry: geo, material } : null }
  pickAt(x, y, z, reach) {
    let best = null
    for (const t of this.things) {
      const d = Math.hypot(t.x - x, t.y - y, t.z - z) - t.size / 2
      if (d < reach && (!best || d < best.dist)) best = { dist: Math.max(0, d), t, size: t.size }
    }
    return best
  }
  take(hit) {
    const t = hit.t
    this.things.splice(this.things.indexOf(t), 1)
    this.taken.add('mushroom', t.x, t.z)
    return { kind: 'mushroom', name: 'mushroom', size: t.size, geometry: geo, material, attrs: {}, color: [0.123456789, 0.5, 0.5], scale: [t.size, t.size, t.size], stowable: true }
  }
  evict(key, x, z) {
    if (key !== 'mushroom') return false
    const t = this.things.find((t) => Math.abs(t.x - x) < 0.05 && Math.abs(t.z - z) < 0.05)
    if (!t) return false
    this.evicted.push(t)
    this.take({ t })
    return true
  }
}

class StubNet {
  constructor() { this.open = false; this.sent = []; this.things = []; this.peers = new Map(); this.id = null; this.welcomes = 0 }
  sendThing(m) { if (!this.open) return false; this.sent.push(JSON.parse(JSON.stringify(m))); return true }
  welcome(id) { this.id = id; this.welcomes++; this.open = true }
}
class StubAvatars {
  constructor() { this.wrists = new Map() }
  handAt(id, side, pos, quat) {
    const w = this.wrists.get(`${id}:${side}`)
    if (!w) return false
    pos.set(w[0], w[1], w[2]); quat.identity()
    return true
  }
}

const build = () => {
  const taken = new Taken()
  const scene = new THREE.Scene()
  const hands = new Hands(scene, { walk, water, haptic() {}, stow: () => true, thud() {}, rand: mulberry32(3) })
  const src = new Source([{ x: 0, y: 0, z: 0, size: 0.2 }, { x: 3, y: 0, z: 0, size: 0.2 }, { x: 6, y: 0, z: 0, size: 0.2 }], taken)
  hands.addSource(src, 'mushroom')
  const node = new THREE.Group()
  scene.add(node)
  hands.addHand('right', node)
  const head = { x: 0, y: 1.6, z: 0, yaw: 0 }
  const at = (x, y, z) => { node.position.set(x, y, z); node.updateMatrixWorld(true) }
  const net = new StubNet()
  const avatars = new StubAvatars()
  const hn = new HandsNet(hands, net, avatars, taken)
  const run = (s, dt = 1 / 60) => { for (let t = 0; t < s; t += dt) { hands.update(dt, head); hn.update() } }
  return { hands, src, taken, net, avatars, hn, at, head, run }
}
const slotOf = (m) => m.slot
const ME = 'aabbccdd-1111-2222-3333-444444444444'

// --- the constructor -------------------------------------------------------------------
{
  const w = build()
  let threw = 0
  for (const args of [[null, w.net, w.avatars, w.taken], [w.hands, {}, w.avatars, w.taken], [w.hands, w.net, {}, w.taken], [w.hands, w.net, w.avatars, null]]) { try { new HandsNet(...args) } catch { threw++ } }
  check(threw === 4, 'the constructor throws without the hands, the netplay, the avatars or the registry', `${threw} of 4`)
}

// --- out: her hands to the relay -------------------------------------------------------
{
  const w = build()
  // Before the relay answers: a take is a hold in the queue; a drop is a hold of nothing and no loose thing, since it has no id yet.
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.run(0.05)
  check(w.net.sent.length === 0 && w.hn.stats.queued === 2, 'before the welcome nothing leaves: the hold and the take wait', `${w.hn.stats.queued} queued`)
  w.hands.press('right', w.head)
  w.run(ROLL_MAX_S + 1)
  // The welcome: the queue is rebuilt from what is true -- an empty hand, the loose thing named now, the taken entry.
  w.net.welcome(ME)
  w.run(0.05)
  const types = w.net.sent.map((m) => m.type)
  check(w.hands.tag === 'aabbccdd', 'the welcome tags her with the first 8 hex of her id', w.hands.tag)
  check(types.join(',') === 'hold,loose,take', 'and sends what is true now: each hand, every loose thing, the taken log', types.join(','))
  check(w.net.sent[0].hand === 1 && w.net.sent[0].slot === null, 'the right hand as index 1, empty')
  const loose = w.net.sent[1]
  check(loose.id === 'aabbccdd-0' && loose.state === 0 && loose.pose.length === 7 && loose.pose.every((v) => v === Math.round(v * 1000) / 1000), 'the loose thing under her tag, still, its pose to 3 decimals', JSON.stringify(loose.pose))
  check(JSON.stringify(w.net.sent[2].list) === '[["mushroom",0,0]]', 'the taken log as [key, x, z]', JSON.stringify(w.net.sent[2].list))
  // Live: a take is one hold and one take entry, sent once, with the slot's numbers rounded.
  w.net.sent.length = 0
  w.at(3, 0.3, 0)
  w.hands.press('right', w.head)
  w.run(0.1)
  check(w.net.sent.length === 2 && w.net.sent[0].type === 'hold' && w.net.sent[0].hand === 1 && slotOf(w.net.sent[0]).kind === 'mushroom' && w.net.sent[1].type === 'take' && w.net.sent[1].list[0][1] === 3, 'a take from a bed is a hold and a take entry, once', w.net.sent.map((m) => m.type).join(','))
  check(slotOf(w.net.sent[0]).color[0] === 0.123, 'the slot\'s numbers are rounded for the wire', `${slotOf(w.net.sent[0]).color[0]}`)
  w.net.sent.length = 0
  w.hands.press('right', w.head)
  w.run(0.05)
  check(w.net.sent.length === 2 && w.net.sent[0].type === 'hold' && w.net.sent[0].slot === null && w.net.sent[1].type === 'loose' && w.net.sent[1].id === 'aabbccdd-1' && w.net.sent[1].state === 2, 'a drop is a hold of nothing and a loose thing in motion', w.net.sent.map((m) => m.type).join(','))
  w.net.sent.length = 0
  w.run(ROLL_MAX_S + 1)
  check(w.net.sent.length === 1 && w.net.sent[0].type === 'loose' && w.net.sent[0].id === 'aabbccdd-1' && w.net.sent[0].state === 0, 'its rest is one more loose, still; nothing per frame between', `${w.net.sent.length}`)
  // The socket down: events wait, capped; up again under the same welcome they go in order.
  w.net.open = false
  w.net.sent.length = 0
  for (let i = 0; i < 600; i++) w.hands.sync({ type: 'lift', id: `aabbccdd-${i.toString(36)}` })
  w.run(0.05)
  check(w.net.sent.length === 0 && w.hn.stats.queued === 512, 'with the socket down the queue holds the newest 512', `${w.hn.stats.queued}`)
  w.net.open = true
  w.run(0.05)
  check(w.net.sent.length === 512 && w.net.sent[0].id === `aabbccdd-${(88).toString(36)}` && w.hn.stats.queued === 0, 'up again, they go in order, oldest first')
  // A new welcome (a dropped socket): the relay knows nothing, so the hands, the loose things and the log go again.
  w.net.sent.length = 0
  for (let i = 0; i < 150; i++) w.taken.add('carrot', i, i)
  w.net.welcome('eeeeffff-0000-1111-2222-333333333333')
  w.run(0.05)
  const again = w.net.sent.map((m) => m.type)
  check(again.join(',') === 'hold,loose,loose,take,take' && w.net.sent[3].list.length === 100 && w.net.sent[4].list.length === 52, 'a new welcome resends each hand, every loose thing and the whole log in chunks of 100', again.join(','))
  check(w.hands.tag === 'eeeeffff' && w.net.sent[1].id === 'aabbccdd-0', 'the new tag names what is dropped from now; the old ids stand')
}

// --- in: the room's things here ----------------------------------------------------------
{
  const w = build()
  w.net.welcome(ME)
  w.run(0.05)
  w.net.sent.length = 0
  const slot = { kind: 'mushroom', name: 'mushroom', size: 0.2, attrs: {}, color: [0.5, 0.5, 0.5], scale: [0.2, 0.2, 0.2], stowable: true }
  const P1 = 'p1p1p1p1-0000-0000-0000-000000000000'
  const gripPose = (x, y, z) => [0, 1.6, 0, 0, 0, 0, 1, x, y, z, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]
  w.net.peers.set(P1, { id: P1, pose: gripPose(5, 1, 5), hands: [true, false] })
  // A peer's hands, and her own id skipped.
  w.net.things.push({ held: [[P1, slot, null, { ...slot, name: 'desk' }], [ME, slot, slot, slot]] })
  w.run(0.05)
  check(w.net.things.length === 0 && w.hands.peerHeld.size === 1 && w.hands.peerHeld.get(P1)[0].item && w.hands.peerHeld.get(P1)[2].item, 'a peer\'s held slots are copies here; her own echo is not', `${w.hands.peerHeld.size} peers`)
  const grip = w.hands.peerHeld.get(P1)[0].item
  check(Math.abs(grip.x - (5 + HOLD_OFFSET.x)) < 1e-9 && Math.abs(grip.y - (1 + HOLD_OFFSET.y)) < 1e-9 && Math.abs(grip.z - (5 + HOLD_OFFSET.z)) < 1e-9, 'the copy in a controller hand is at the grip, offset as hers is', `${grip.x} ${grip.y} ${grip.z}`)
  const desk = w.hands.peerHeld.get(P1)[2].item
  check(desk.y < -1000, 'the desktop hand\'s copy waits out of sight without a body to put it at')
  w.avatars.wrists.set(`${P1}:1`, [7, 1.1, 7])
  w.run(0.05)
  check(desk.x === 7 && desk.y === 1.1 && desk.z === 7, 'with a body it is at the right wrist')
  w.net.peers.get(P1).hands = [false, false]
  w.avatars.wrists.set(`${P1}:0`, [8, 1.2, 8])
  w.run(0.05)
  check(grip.x === 8 && grip.y === 1.2, 'a controller put down, the copy moves to the wrist')
  check(w.net.sent.length === 0, 'nothing of a peer\'s hands goes back to the relay')
  // A peer's loose thing, one of hers echoed, a lift, a thing not yet dressable.
  w.net.things.push({ loose: [['p1p1p1p1-0', slot, [-5, 1, 0, 0, 0, 0, 1], 2, P1], ['aabbccdd-9', slot, [9, 9, 9, 0, 0, 0, 1], 0, ME]] })
  w.run(0.05)
  check(w.hands.loose.length === 1 && w.hands.loose[0].netId === 'p1p1p1p1-0' && w.hands.loose[0].mine === false, 'a peer\'s loose thing appears; hers by the relay is not made twice', `${w.hands.loose.length}`)
  w.src.landed = false
  w.net.things.push({ loose: [['p1p1p1p1-1', slot, [-6, 1, 0, 0, 0, 0, 1], 0, P1]] })
  w.run(0.05)
  check(w.hands.loose.length === 1 && w.hn.stats.pending === 1, 'a thing whose source has not landed is kept to try again', `${w.hn.stats.pending} pending`)
  w.src.landed = true
  w.run(0.05)
  check(w.hands.loose.length === 2 && w.hn.stats.pending === 0, 'and lands when it can')
  w.net.things.push({ gone: ['p1p1p1p1-0', 'nobody-1'] })
  w.run(0.05)
  check(w.hands.loose.length === 1 && w.hands.loose[0].netId === 'p1p1p1p1-1', 'a gone id is lifted; an unknown one is nothing')
  w.run(ROLL_MAX_S + 1)
  check(w.net.sent.length === 0, 'a peer\'s thing coming to rest here is not reported')
  // A peer's take: evicted from the bed here, recorded, and not sent back as hers.
  w.net.things.push({ take: [['mushroom', 6.0004, 0], ['fern', 1, 2], ['mushroom', 100, 100]] })
  w.run(0.05)
  check(w.src.evicted.length === 1 && w.src.evicted[0].x === 6 && w.src.things.length === 2, 'the bed evicts what a peer took, within the registry\'s tolerance', `${w.src.evicted.length}`)
  check(w.taken.has('mushroom', 6, 0) && w.taken.has('fern', 1, 2) && w.taken.has('mushroom', 100, 100), 'every entry is in the registry, a foreign key and an ungrown spot straight in')
  check(w.net.sent.length === 0, 'and none of them goes back to the relay as hers', `${w.net.sent.length} sent`)
  w.net.things.push({ take: [['mushroom', 6, 0]] })
  w.run(0.05)
  check(w.src.evicted.length === 1 && w.taken.byKind.get('mushroom').length === 4, 'an entry already here is nothing')
  // Her own take after that is still hers.
  w.at(3, 0.3, 0)
  w.hands.press('right', w.head)
  w.run(0.05)
  check(w.net.sent.some((m) => m.type === 'take' && m.list[0][1] === 3), 'her own take after a peer\'s still goes out')
  // A peer gone from the room takes its copies.
  w.net.peers.delete(P1)
  w.run(0.05)
  check(w.hands.peerHeld.size === 0 && w.hands.stats.peers === 0, 'a peer gone from the room takes its copies with it')
  check(w.hn.stats.heard === 6, 'the stats count what was heard', `${w.hn.stats.heard}`)
}

console.log(failures === 0 ? 'check-hands-net: all passed' : `check-hands-net: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
