// Node-side gates for leading a tamed wild strider by the rein (src/v2/render/wild-striders.js lead), and for her torch held to one.
//
//   node scripts/check-strider-lead.mjs
//
// What can go wrong without throwing: a peer's tamed strider that shies from her; a led one that stands off at the wild follow's distances, or never lets go; a rein left in her hand after she mounts it; a singed one that never tells the room its hurt, or runs on out of sight.

import * as THREE from 'three'
import { WILD, WildStriders } from '../src/v2/render/wild-striders.js'
import { SINGE } from '../src/v2/singe.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

/** A layer with only what leading reads, and one strider keyed `key` at the origin heading +x (forward (cos, -sin) of the heading), size 1.5 (the mean); `trusted` hers, else tamed by a peer. */
function layer(trusted) {
  const S = Object.create(WildStriders.prototype)
  S.walk = { heightAt: () => 0, waterAt: () => null, obstacleAt: () => false }
  S.bond = { trusted: new Set(trusted ? ['k'] : []), grown: new Map() }
  S.tamed = new Set(['k'])
  S.anchors = new Map()
  S.outbox = []
  S.live = new Map()
  S.struck = new Set()
  S.scars = new Map()
  S.torches = []
  S.now = 0
  S.ridden = S.led = S.leadBy = null
  S.walkV = 1
  S.runV = 4
  S._say = S._chirp = S._rehome = S._graze = S._lookAt = () => {}
  S._open = () => true
  // Its jowl a metre ahead of it and 1.5 m up, its body 2 m long.
  S.inner = { asset: { sizeM: 2 / 1.5 }, bites: () => false, jowl: (m, out) => out.set(m.pose.x + Math.cos(m.pose.heading), 1.5, m.pose.z - Math.sin(m.pose.heading)) }
  const m = { key: 'k', by: null, state: 'calm', t: 0, cue: 0, since: 0, aim: 0, singe: 0, dash: { wob: 0, left: 0 }, dist: 1, sendAt: 0, moving: false, want: { yaw: 0, pitch: 0, roll: 0 }, pose: { x: 0, y: 0, z: 0, heading: 0, size: 1.5, speed: 0, clip: 'idle', cue: 0, swim: false } }
  S.live.set('k', m)
  return { S, m }
}
const step = (S, m, x, z, lures = []) => S._step(m, 1 / 72, { x, y: 1.6, z }, { x, y: 0, z }, lures)

console.log('taking the rein')
{
  const { S, m } = layer(false)
  step(S, m, 2, 0)
  check(m.state === 'calm', "a peer's tamed one lets her come up to its face", m.state)
  step(S, m, 0, 2)
  check(m.state === 'calm', 'and to its side, trusting her as it does its tamer', m.state)
}

console.log('a torch held to it')
{
  const { S, m } = layer(false)
  S.torches = [{ x: 0.2, y: 1, z: 0.3 }]
  for (let t = 0; t < 0.9; t += 1 / 72) step(S, m, 0, 1.5)
  check(m.state === 'calm' && !S.scars.has('k'), 'held under a second, a tamed one takes no harm', m.state)
  for (let t = 0; t < 0.2 && m.state === 'calm'; t += 1 / 72) step(S, m, 0, 1.5)
  const a = S.outbox.at(-1)
  check(m.state === 'shy' && S.scars.get('k').hp === SINGE.max - SINGE.hp, `a second costs it ${SINGE.hp} hp, and it shies`, `${m.state}, ${S.scars.get('k')?.hp} hp`)
  check(a[7] === 'shy' && a[15] === SINGE.max - SINGE.hp && a[16] === S.now, 'owing the room its hp and when it was hurt', JSON.stringify(a))
  S.torches = []
  for (let t = 0; t < 10 && m.state === 'shy'; t += 1 / 72) step(S, m, 0, 1.5)
  const d = Math.hypot(m.pose.x, m.pose.z)
  check(m.state === 'calm' && d >= WILD.shy.run[0] - 0.5 && d <= WILD.shy.run[1] + 0.5, 'stopping a few metres off', `${m.state} at ${d.toFixed(2)} m`)
}
{
  const { S, m } = layer(false)
  S.tamed.clear()
  // Wary, it backs off from her: the torch kept to it.
  for (let t = 0; t < 1.1 && m.state !== 'flee'; t += 1 / 72) {
    S.torches = [{ x: m.pose.x, y: 1, z: m.pose.z }]
    step(S, m, 6, 0)
  }
  check(m.state === 'flee' && S.scars.get('k').hp === SINGE.max - SINGE.hp, 'a wild one flees', m.state)
}

console.log('a meal')
{
  const { S, m } = layer(true)
  S.scars.set('k', { hp: 50, at: 3 })
  S.inner.bites = () => true
  S.eat = () => true
  S.dur = { peck: 0.5 }
  m.lure = { kind: 'fish', by: null, x: 1, y: 1.5, z: 0 }
  S._enter(m, 'eat')
  for (let t = 0; t < 2 && m.state === 'eat'; t += 1 / 72) step(S, m, 2, 0)
  const scar = S.scars.get('k')
  check(m.state !== 'eat' && scar.hp === 50 + SINGE.hp && scar.at === 3, `a fish eaten heals it ${SINGE.hp} hp, the hurt kept at its time`, JSON.stringify(scar))
  const V = layer(true).S
  V.live.clear()
  V.scars.set('k', { hp: 50, at: 3 })
  const heard = S.outbox.at(-1).slice()
  heard[8] = 'peer'
  V.apply(heard, S.now)
  check(V.scars.get('k').hp === 50 + SINGE.hp, "and a peer told of it takes the healing", JSON.stringify(V.scars.get('k')))
}

console.log('a crab or spider in her hand')
const held = (kind, by = null) => [{ kind, by, x: 0, y: 1.2, z: 2 }]
{
  const { S, m } = layer(false)
  step(S, m, 0, 2.5, held('fish'))
  check(m.state === 'calm', 'a fish of hers does not scare it', m.state)
  step(S, m, 0, 2.5, held('crab'))
  check(m.state === 'shy', 'her crab within reach makes a tamed one shy', m.state)
}
{
  const { S, m } = layer(false)
  step(S, m, 0, 2.5, held('crab', 'peer'))
  check(m.state === 'shy', "and so does a peer's", m.state)
}
{
  const { S, m } = layer(false)
  S.tamed.clear()
  step(S, m, 0, 2.5, held('spider'))
  check(m.state === 'flee', 'her spider makes a wild one flee', m.state)
}
{
  const { S, m } = layer(false)
  const o = new THREE.Vector3(1, 1.6, 1.5), dir = new THREE.Vector3(0, 0, -1)
  check(S.leadableOnRay(o, dir, 2) === m, 'a click ray past its jowl finds it')
  check(S.leadableOnRay(o.set(1, 1.6, 1.5).setX(2), dir, 2) === null, 'one passing a metre off does not')
  check(S.leadableAt(new THREE.Vector3(1.2, 1.4, 0.1)) === m, 'a hand at its jowl finds it')
  S.lead(m, 'left')
  check(S.led === m && S.leadBy === 'left' && m.state === 'led', 'taking it leads it, in the hand that took it')
  check(S.outbox.at(-1)[7] === 'led', 'and owes the room a led anchor', S.outbox.at(-1)[7])
}

console.log('led')
{
  const { S, m } = layer(true)
  S.lead(m, 'desk')
  step(S, m, WILD.lead.walk - 0.5, 0)
  check(!m.moving && m.pose.x === 0, `under WILD.lead.walk (${WILD.lead.walk} m) it stands`)
  step(S, m, WILD.lead.walk + 0.5, 0)
  check(m.moving && m.pose.clip === 'walk' && m.pose.x > 0, 'past it it walks after her', m.pose.clip)
  for (let i = 0; i < 72 * 3 && m.moving; i++) step(S, m, WILD.lead.walk + 0.5, 0)
  check(!m.moving && WILD.lead.walk + 0.5 - m.pose.x <= WILD.lead.stand + 0.05, `and stops within WILD.lead.stand (${WILD.lead.stand} m) of her`, `${(WILD.lead.walk + 0.5 - m.pose.x).toFixed(2)} m`)
  step(S, m, m.pose.x + WILD.lead.run + 1, 0)
  check(m.pose.clip === 'run', `past WILD.lead.run (${WILD.lead.run} m) it runs`, m.pose.clip)
  step(S, m, m.pose.x + WILD.lead.lose + 1, 0)
  check(m.state === 'calm', `past WILD.lead.lose (${WILD.lead.lose} m) the rein slips and it calms`, m.state)
}

console.log('letting go')
{
  const { S, m } = layer(true)
  S.lead(m, 'right')
  S.unlead()
  check(S.led === null && m.state === 'calm', 'letting go calms it')
  S.lead(m, 'right')
  S._set = () => {}
  S._seat = (q, out) => out.set(0, 1, 0)
  S.mount(m, { scale: 1, mountAt() {} })
  check(S.led === null && S.ridden === m && m.ride.askew === 0, 'mounting the one she leads takes the rein from her hand')
}

console.log("a town's tied strider")
{
  const { S } = layer(true)
  S.ids = 0
  S.lead(S.live.get('k'), 'left')
  S.borrowLed({ key: 'town:0:1', pose: { x: 5, y: 2, z: 1, heading: 1 }, size: 1.5 }, 'right')
  const t = S.led
  check(t.key === 'town:0:1' && t.tack && t.state === 'led' && S.leadBy === 'right', 'lent to her on its rein: led, in the hand that took it, keeping its tack')
  check(t.pose.x === 5 && t.pose.y === 2 && t.pose.heading === 1, 'from where it stood at its rail')
  check(S.live.get('k').state === 'calm', 'and the one she led before let go')
}

console.log('a wild strider and her overhead')
{
  const { S, m } = layer(false)
  S.tamed.clear()
  // A charge marks it struck, which makes the next one a flee.
  const at = (y) => { m.state = 'calm'; S.struck.clear(); S._step(m, 1 / 72, { x: 2, y: y + 1.6, z: 0 }, { x: 2, y, z: 0 }, []); return m.state }
  check(at(300) === 'calm', `${WILD.strike - 2} m off across the ground but 300 m over it, it never notices her`)
  S.maddened = true
  check(at(300) === 'calm', 'nor charges her there when her chanterelle maddens it')
  S.maddened = false
  check(at(0) === 'charge', 'standing that near on the ground, it charges her')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
