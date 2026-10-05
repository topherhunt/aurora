// Node-side gates for the headset's ride on a wild strider (src/v2/render/wild-striders.js): its hops and its turns after her.
//
//   node scripts/check-strider-ride.mjs
//
// What can go wrong without throwing: her view turned by a hop she aimed to the side (the sickness the ride exists to avoid); a strider that follows every glance, or never follows her body round; a side hop as long as a forward one.

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

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
