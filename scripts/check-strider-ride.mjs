// Node-side gates for the headset's ride on a wild strider (src/v2/render/wild-striders.js): its hops and its turns after her, and a peer's ride under them.
//
//   node scripts/check-strider-ride.mjs
//
// What can go wrong without throwing: her view turned by a hop she aimed to the side (the sickness the ride exists to avoid); a strider that follows every glance, or never follows her body round; a side hop as long as a forward one; a peer riding nothing, their strider let go here while she was away and never brought back.

import * as THREE from 'three'
import { WILD, WildStriders } from '../src/v2/render/wild-striders.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
// The creatures' heading (forward (cos, -sin)) as the Player's headYaw has it (atan2 of x over z).
const yawOf = (h) => Math.atan2(Math.cos(h), -Math.sin(h))

/** A layer with only what the ride reads, riding a strider at the origin heading +x; `carries` gets each carry's turn. */
function riding() {
  const S = Object.create(WildStriders.prototype)
  S.walk = { heightAt: () => 0, waterAt: () => null }
  S.dur = { fidget: 1 }
  S.walkV = 1
  S._seat = (m, out) => out.set(m.pose.x, m.pose.y + 1, m.pose.z)
  S._float = () => {}
  S._set = () => {}
  S._say = () => {}
  S._chirp = () => {}
  S._shake = () => {}
  S._deep = () => false
  const pose = { x: 0, y: 0, z: 0, heading: 0, size: 1, swim: false }
  S.ridden = { pose, want: { yaw: 0, pitch: 0, roll: 0 }, ride: { y: 1, lastY: 1, bob: 0, turn: 0, w: 0, lead: 0, askew: 0, gain: 1, last: null, still: 0, tread: 0, fidget: 99, fid: 0, fall: null, base: { x: 0, z: 0, h: 0 }, off: { x: 0, z: 0, h: 0 } } }
  const player = { yaw: yawOf(0), carries: [], headYaw() { return this.yaw }, carry(dx, dy, dz, turn) { this.carries.push(turn) } }
  return { S, m: S.ridden, player }
}

console.log('the hop')
{
  const { S, m, player } = riding()
  check(near(S.hopAim(1, 0), 1) && near(S.hopAim(0, 1), WILD.hop.side) && near(S.hopAim(-1, 0), WILD.hop.side), 'its whole reach straight ahead, WILD.hop.side of it to the side and behind', `${S.hopAim(0, 1)}, ${S.hopAim(-1, 0)}`)
  const diag = S.hopAim(1, 1), off = S.hopAim(Math.cos(0.2), Math.sin(0.2))
  check(diag > WILD.hop.side && diag < 1 && off > 0.95, 'falling off between: barely a little off its way, much at 45 degrees', `${off.toFixed(3)} at 0.2 rad, ${diag.toFixed(3)} at 45 degrees`)
  m.ride.turn = Math.PI / 2
  check(near(S.hopAim(0, -1), 1), 'ahead is the way it is turning to, before it gets there')
  m.ride.turn = 0.4
  S.hop(0, 0, 3, 10, player)
  check(m.pose.heading === 0 && m.pose.z === 3 && m.ride.base.h === 0, 'a hop to the side moves it there still facing its way')
  check(player.carries.length === 1 && player.carries[0] === 0, 'and carries her there without turning her', `turned ${player.carries[0]}`)
  check(m.ride.turn === 0.4, 'the turn it owed her still owed')
}

console.log('turning after her')
{
  const { S, m, player } = riding()
  player.yaw = yawOf(1.2)
  for (let i = 0; i < 4; i++) S._face(m, 0.1, player)
  player.yaw = yawOf(0)
  for (let i = 0; i < 10; i++) S._face(m, 0.1, player)
  check(m.ride.turn === 0, 'a glance away and back does not turn it')
  player.yaw = yawOf(WILD.ride.face * 0.8)
  for (let i = 0; i < 30; i++) S._face(m, 0.1, player)
  check(m.ride.turn === 0, 'nor does her head held a little off its way')
  player.yaw = yawOf(1.2)
  let turned = 0
  for (; turned < 30 && m.ride.turn === 0; turned++) S._face(m, 0.1, player)
  check(near(m.ride.turn, 1.2) && near(turned * 0.1, WILD.ride.dwell, 0.11), 'her body turned past WILD.ride.face for WILD.ride.dwell s: it owes the turn to face her', `${m.ride.turn.toFixed(3)} rad after ${(turned * 0.1).toFixed(1)} s`)
  player.carries.length = 0
  let t = 0
  for (; t < 5 && !near(m.pose.heading, 1.2, 1e-3); t += 1 / 72) S.sit(1 / 72, player)
  check(near(m.pose.heading, 1.2, 1e-3) && t > 0.5, 'and swings round to it over time, not at once', `${t.toFixed(2)} s`)
  check(player.carries.every((a) => a === 0), 'never turning her view while it does')
  for (let i = 0; i < 144; i++) S.sit(1 / 72, player)
  check(near(wrap(m.pose.heading - 1.2), 0, 1e-3) && m.ride.turn === 0, 'turning no further once it faces her', `heading ${m.pose.heading.toFixed(4)}, owes ${m.ride.turn}`)
}

console.log("a peer's ride")
{
  /** A layer with only what an anchor reads, her feet at the origin, flat dry ground everywhere. */
  const room = () => {
    const S = Object.create(WildStriders.prototype)
    Object.assign(S, { walk: { heightAt: () => 0, slopeAt: () => 0 }, avoid: null, bond: { trusted: new Set(), grown: new Map() }, tamed: new Set(), scars: new Map(), anchors: new Map(), live: new Map(), away: new Set(), homes: new Map(), struck: new Set() })
    Object.assign(S, { now: 100, feet: { x: 0, z: 0 }, booted: true, loaded: true, ridden: null, ids: 0, runV: 4 })
    S._dry = () => true
    S._set = S._say = () => {}
    return S
  }
  const S0 = room()
  let ix = 20
  while (!S0._home(ix, 0)) ix++
  const key = `${ix},0`
  const ridden = (x, z) => [`ws:${key}`, 100, x, 0, z, 0, -1, 'ridden', 'peer', 1.5, 3, 1, 0, 90, 0, null, null]
  const S = room()
  S.apply(ridden(10, 5), 100)
  const m = S.live.get(key)
  check(m !== undefined && m.by === 'peer' && m.state === 'ridden' && m.pose.x === 10 && m.pose.z === 5, 'ridden by a peer beside her, far from its home: it is under them where their anchor has it', m ? `${m.state} by ${m.by} at ${m.pose.x}, ${m.pose.z}` : 'no body')
  const T = room()
  T.away.add(key)
  T.apply(ridden(10, 5), 100)
  check(T.live.has(key) && !T.away.has(key), 'and so when it was let go here while still in range of its home')
  const U = room()
  U.apply(ridden(WILD.spawn + 10, 0), 100)
  check(!U.live.has(key), 'but not while their anchor has it out of her range')
  const V = room()
  V.apply([`ws:${key}`, 100, 300, 0, 0, 0, -1, 'shy', 'peer', 1.5, 0, 1, 0, 90, 0, 80, 99.5], 100)
  check(V.scars.get(key)?.hp === 80 && V.scars.get(key).at === 99.5, "a peer's singeing is kept, though the body is out of her range", JSON.stringify(V.scars.get(key)))

  console.log('felled')
  /** `S` stepped `s` seconds through update with a drawing layer that keeps no puppets. */
  const run = (S, s) => {
    for (let t = 0; t < s; t += 0.1) {
      S.now += 0.1
      S.update(0.1, { x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: 0 }, [], S.now, [], [])
    }
  }
  const quiet = (S) => {
    Object.assign(S, { list: [], led: null, outbox: [], returned: () => { throw new Error('a felled strider returned to town') } })
    S.inner = { begin() {}, draw() {}, end() {}, release() {} }
    S._scan = () => {}
    S._cry = () => { S.cried = (S.cried ?? 0) + 1 }
    return S
  }
  const W = quiet(room())
  W.apply([`ws:${key}`, 100, 10, 0, 5, 0, -1, 'shy', 'peer', 1.5, 0, 1, 0, 90, 0, 80, 99.5], 100)
  W.apply([`ws:${key}`, 100.5, 10, 0, 5, 0, -1, 'rejoin', 'peer', 1.5, 0, 1, 0, 90, 0, 0, 100.5], 100.5)
  const w = W.live.get(key)
  W.now = 100.5
  W.cried = 0
  run(W, 0.1)
  check(w.state === 'dead' && w.fell === 100.5 && w.pose.speed === 0 && W.cried === 1, "a peer's anchor bringing it to 0 hp: it cries out and falls where it is", `${w.state}, fell ${w.fell}, cried ${W.cried}`)
  const at = { x: w.pose.x, z: w.pose.z }
  run(W, 3)
  check(W.live.get(key) === w && !w.gone && w.pose.x === at.x && w.pose.z === at.z, 'it lies still where it fell till FELL.lie')
  run(W, 0.6)
  check(w.gone && !W.live.has(key), 'then dissolves out of the world')
  const spawned = []
  W._scan = WildStriders.prototype._scan
  W._spawn = (k) => spawned.push(k)
  W._scan(0, 0)
  check(spawned.length > 0 && !spawned.includes(key), 'and is never spawned again', `${spawned.length} others spawned`)
  W.apply([`ws:${key}`, 101, 10, 0, 5, 0, -1, 'shy', 'peer', 1.5, 0, 1, 0, 90, 0, 0, 100.5], 101)
  check(!W.live.has(key), "nor brought back by a peer's anchor")
  const X = quiet(room())
  X.apply([`ws:${key}`, 100, 10, 0, 5, 0, -1, 'shy', 'peer', 1.5, 0, 1, 0, 90, 0, 10, 99.5], 100)
  const x = X.live.get(key)
  x.by = null
  X._enter = () => { throw new Error('a strider singed to death fled') }
  X._burn(x, false)
  const sent = X.outbox.at(-1)
  check(x.state === 'dead' && sent[15] === 0 && sent[16] === 100, 'her torch taking its last 10 hp: it falls rather than flees, and the room hears 0 hp', JSON.stringify(sent))
}

console.log('a crab in a hand')
{
  const { S, m, player } = riding()
  Object.assign(S, { runV: 4, crowd: null, lures: [], _rideStep: (q, d) => { q.pose.x += Math.cos(q.pose.heading) * d; q.pose.z -= Math.sin(q.pose.heading) * d; return true } })
  S.walk.obstacleAt = () => false
  Object.assign(m.ride, { want: 'stop', goal: 'stop', wait: 0, pace: 1, v: 0, a: 0, neck: 0, phase: 0, swim: false, wet: false, willing: false, coax: 0, need: 5, squawk: 0, balk: 0, weave: 0, half: 3, reach: 0.2, sway: 0, bolt: null })
  const still = { push: 0, steer: 0, face: false }
  // A peer's crab a few metres off its left flank (+z is its right, heading +x).
  S.lures = [{ kind: 'crab', by: 'peer', x: 0.5, y: 1, z: -3 }]
  S.ride(1 / 72, still, player)
  const bolt = m.ride.bolt
  check(bolt !== null && bolt.left >= WILD.ride.bolt[0] && bolt.left <= WILD.ride.bolt[1], "a peer's crab near her mount sets it bolting", JSON.stringify(bolt))
  S.lures = []
  let t = 0
  for (; t < 20 && m.ride.bolt !== null; t += 1 / 72) S.ride(1 / 72, still, player)
  const ran = Math.hypot(m.pose.x, m.pose.z)
  check(m.ride.bolt === null && ran >= WILD.ride.bolt[0] - 0.5 && m.pose.z > 0, 'it runs its metres away from the crab, her stick untouched', `${ran.toFixed(2)} m to (${m.pose.x.toFixed(2)}, ${m.pose.z.toFixed(2)}) in ${t.toFixed(2)} s`)
  for (let i = 0; i < 72 * 5; i++) S.ride(1 / 72, still, player)
  check(m.ride.v === 0, 'then calms under her', `${m.ride.v.toFixed(3)} m/s`)
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
