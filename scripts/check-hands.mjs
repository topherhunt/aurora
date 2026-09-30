// Node-side gates for her hands (src/v2/hands.js) and the taken registry
// (src/v2/taken.js): the grab, the hold, the drop and its short simulation, the
// backpack zone and its buzz, the stow, the packed slot and its way back into a
// hand, the photograph. Run against a stub source and a stub renderer so every
// branch is reached without a bed or a GPU; the beds' own take/release/dress
// are gated in their own scripts.
//
//   node scripts/check-hands.mjs
//
// What can go wrong without throwing: a held thing drawn somewhere other than
// the hand; a drop that never lands, or lands and never stops, or rolls with
// its top turning against its travel, or at one even speed, or lands and does
// not roll, or lands without a sound; a dropped thing she cannot pick up
// again; a click down a ray that takes what is past its reach; a mushroom sinking to the
// lake bed, or one afloat that drifts up the beach; a buzz with an empty hand,
// or none as a full one crosses the shoulder; a stow that loses the thing when
// the backpack is full; a slot that comes back out as something else; a pool
// that keeps growing; a bed that regrows what she took.

import * as THREE from 'three'
import { Hands, REACH_M, GRAB_MAX_M, STOW_MAX_M, LOOSE_MAX, ROLL_S, ROLL_MAX_S, ROLL_KICK, RAY_STEP, FLAP_S, FLAP_FADE_S, ZONE, ZONE_PULSE, EASE_S, POOL_CAP, OVER_CAP, CARRY_MAX, CARRIERS, UNPLACED_Y, KICK_S, KICK_BACK, KICK_FLIP, KICK_GROW } from '../src/v2/hands.js'
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

// --- the world: a slope down +x from x = 0, a lake past x = 30 -----------------
const SLOPE = 0.3
const LEVEL = -8
const groundAt = (x) => (x < 0 ? 0 : -SLOPE * x)
const walk = {
  heightAt: (x, z, y) => groundAt(x),
  normalAt(x, z, eps, out = { x: 0, y: 1, z: 0 }) {
    const dx = (groundAt(x + eps) - groundAt(x - eps)) / (2 * eps)
    const l = Math.hypot(dx, 1)
    out.x = -dx / l; out.y = 1 / l; out.z = 0
    return out
  },
}
const water = { levelAt: (x, z) => (x > 30 ? LEVEL : null) }

// --- a stub source: things at fixed spots, the records the beds hand back ------
const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.1, 0)
geo.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(4).fill(1), 1))
geo.setAttribute('aSwim', new THREE.InstancedBufferAttribute(new Float32Array(16), 4))
const material = new THREE.MeshBasicMaterial()
class Source {
  constructor(things) { this.things = things; this.taken = []; this.releases = []; this.takeBack = null; this.landed = true }
  dress(slot) { return this.landed ? { geometry: geo, material } : null }
  pickAt(x, y, z, reach, maxSize) {
    let best = null
    for (const t of this.things) {
      if (t.size >= maxSize) continue
      const d = Math.hypot(t.x - x, t.y - y, t.z - z) - t.size / 2
      if (d < reach && (!best || d < best.dist)) best = { dist: Math.max(0, d), t, size: t.size }
    }
    return best
  }
  take(hit, stowMax) {
    const t = hit.t
    this.things.splice(this.things.indexOf(t), 1)
    this.taken.push(t)
    return { kind: t.kind, name: t.kind, size: t.size, geometry: geo, material, attrs: { aSwim: [1, 2, 3, 4] }, color: [0.5, 0.6, 0.7], scale: [t.size, t.size, t.size], stowable: t.size < stowMax && !t.bulky }
  }
  release(rec, x, y, z, head) {
    this.releases.push({ rec, x, y, z, head: { ...head } })
    return this.takeBack ? this.takeBack(rec, x, y, z) : false
  }
}
const thing = (kind, x, y, z, size) => ({ kind, x, y, z, size })

const build = () => {
  const scene = new THREE.Scene()
  const pulses = []
  const pack = []
  const thuds = []
  const splashes = []
  let room = 8
  const hands = new Hands(scene, { walk, water, haptic: (key, i, ms) => pulses.push({ key, i, ms }), stow: (rec) => { if (pack.length >= room) return false; pack.push(rec); return true }, thud: (x, y, z) => thuds.push({ x, y, z }), splash: (x, y, z) => splashes.push({ x, y, z }), rand: mulberry32(3) })
  const src = new Source([thing('mushroom', 0, 0, 0, 0.2), thing('fish', 2, 0, 0, 0.6), { ...thing('crab', 4, 0, 0, 1.5), bulky: true }, thing('crab', 6, 0, 0, 2.5)])
  hands.addSource(src, ['mushroom', 'fish', 'crab'])
  const node = new THREE.Group()
  scene.add(node)
  hands.addHand('right', node)
  const head = { x: 0, y: 1.6, z: 0, yaw: 0 }
  const at = (x, y, z) => { node.position.set(x, y, z); node.updateMatrixWorld(true) }
  const run = (s, dt = 1 / 60) => { for (let t = 0; t < s; t += dt) hands.update(dt, head) }
  return { scene, hands, src, node, head, at, run, pulses, pack, thuds, splashes, setRoom: (n) => { room = n } }
}

// --- the constructor refuses a missing world ---------------------------------
{
  let threw = 0
  for (const bad of [{ water, haptic() {}, stow() {}, thud() {}, splash() {} }, { walk, haptic() {}, stow() {}, thud() {}, splash() {} }, { walk, water, stow() {}, thud() {}, splash() {} }, { walk, water, haptic() {}, thud() {}, splash() {} }, { walk, water, haptic() {}, stow() {}, splash() {} }, { walk, water, haptic() {}, stow() {}, thud() {} }]) {
    try { new Hands(new THREE.Scene(), bad) } catch { threw++ }
  }
  check(threw === 6, 'the constructor throws without the walk surface, the water, the buzz, the backpack, the thud or the splash', `${threw} of 6`)
  const h = new Hands(new THREE.Scene(), { walk, water, haptic() {}, stow() {}, thud() {}, splash() {} })
  let bad = 0
  try { h.addSource({}) } catch { bad++ }
  try { h.addSource({ pickAt() {}, take() {} }, 'x') } catch { bad++ }
  try { h.addSource(new Source([])) } catch { bad++ }
  try { h.addSource(new Source([]), []) } catch { bad++ }
  try { h.addHand('x', {}) } catch { bad++ }
  try { h.press('nowhere', { x: 0, y: 0, z: 0, yaw: 0 }) } catch { bad++ }
  check(bad === 6, 'a source without pickAt/take/dress or without its kinds, a hand without a node and an unknown hand throw', `${bad} of 6`)
  h.addSource(new Source([]), 'mushroom')
  let twice = false
  try { h.addSource(new Source([]), ['fish', 'mushroom']) } catch { twice = true }
  check(twice, 'two sources handing out one kind throw')
  const liar = new Source([thing('fish', 0, 0, 0, 0.2)])
  h.addSource(liar, 'fish')
  liar.take = () => ({ kind: 'crab', name: 'crab', size: 0.2, geometry: geo, material, attrs: {}, color: null, scale: [1, 1, 1], stowable: true })
  h.addHand('right', new THREE.Group())
  let lied = false
  try { h.press('right', { x: 0, y: 0, z: 0, yaw: 0 }) } catch (e) { lied = /crab/.test(e.message) }
  check(lied, 'a source handing out a kind that is not its own throws, naming it')
}

// --- the grab ------------------------------------------------------------------
{
  const w = build()
  w.at(0, 0.5, 0)
  check(w.hands.press('right', w.head) === null && w.src.taken.length === 0, 'a press with nothing in reach takes nothing', `hand 0.4 m over a 0.2 m cap, reach ${REACH_M}`)
  w.at(0, 0.3, 0)
  check(w.hands.press('right', w.head) === 'pick' && w.src.taken.length === 1 && w.src.taken[0].kind === 'mushroom', 'within reach the nearest thing is taken')
  check(w.hands.holding('right')?.kind === 'mushroom' && w.hands.stats.held === 1, 'and the hand holds its record')
  check(w.hands.drop('right', w.head) === 'drop' && w.hands.holding('right') === null, 'the grip lets it go')
  // The size caps are one, so whatever is lifted would stow; the 1.5 m crab is lifted, and its source alone says it does not stow. A 2.5 m one is never offered.
  w.at(4, 0.7, 0)
  check(STOW_MAX_M === GRAB_MAX_M && w.hands.press('right', w.head) === 'pick' && w.hands.holding('right').size === 1.5 && w.hands.holding('right').stowable === false, `a ${1.5} m crab is lifted, and its source's word on stowing is kept`, `GRAB_MAX ${GRAB_MAX_M} STOW_MAX ${STOW_MAX_M}`)
  w.hands.press('right', w.head)
  w.at(6, 1.2, 0)
  check(w.hands.press('right', w.head) === null, 'a 2.5 m crab is beyond the grab')
}

// --- the hold: drawn at the hand, in its own pool ------------------------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.at(3, 1.4, -2)
  w.hands.update(1 / 60, w.head)
  const pool = w.hands.pools.get(geo)
  check(pool && pool.mesh.count === 0 && pool.mesh.parent === w.hands.batch && pool.over.mesh.count === 1 && pool.over.mesh.parent === w.hands.over && w.hands.over.parent === null, 'one pool for the geometry; what she holds is its one instance on the over mesh, out of the scene')
  const m = new THREE.Matrix4().fromArray(pool.over.mesh.instanceMatrix.array, 0)
  const p = new THREE.Vector3().setFromMatrixPosition(m)
  // The centre of the box is HOLD_OFFSET off the hand; the box's origin is its centre less (0, 0.1, 0) scaled.
  check(Math.abs(p.x - 3) < 1e-6 && Math.abs(p.y - (1.4 - 0.03 - 0.1 * 0.2)) < 1e-6 && Math.abs(p.z - (-2 - 0.06)) < 1e-6, 'the held thing sits a little under and ahead of the hand', `${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)}`)
  const swim = pool.over.geo.getAttribute('aSwim')
  const fade = pool.over.geo.getAttribute('aPropFade')
  check(swim.isInstancedBufferAttribute && swim !== geo.getAttribute('aSwim') && swim.array[0] === 1 && swim.array[3] === 4, "the record's instanced attributes ride the pool's own copy", Array.from(swim.array.slice(0, 4)).join(','))
  check(fade.array[0] === 1 && pool.over.geo.getAttribute('position') === geo.getAttribute('position') && pool.over.geo.index === geo.index, 'aPropFade defaults to 1; the vertex buffers are shared')
  const c = pool.over.mesh.instanceColor.array
  check(Math.abs(c[0] - 0.5) < 1e-6 && Math.abs(c[2] - 0.7) < 1e-6, 'the tint is the record colour')
  const s = new THREE.Vector3().setFromMatrixScale(m)
  check(Math.abs(s.x - 0.2) < 1e-6, 'and the scale the record scale')
  // Drawn smaller: the scale and the offset to the centre shrink together, so the centre stays at the hand.
  w.hands.draw('right', 0.5)
  w.hands.update(1 / 60, w.head)
  m.fromArray(pool.over.mesh.instanceMatrix.array, 0)
  p.setFromMatrixPosition(m)
  check(Math.abs(new THREE.Vector3().setFromMatrixScale(m).x - 0.1) < 1e-6 && Math.abs(p.y - (1.4 - 0.03 - 0.1 * 0.2 * 0.5)) < 1e-6, 'draw(key, k) draws what the hand holds k times smaller about the same centre', `${p.y.toFixed(4)}`)
  let threw = 0
  for (const k of [0, 1.5, 'x']) { try { w.hands.draw('right', k) } catch { threw++ } }
  check(threw === 3, 'and a draw scale outside (0, 1] throws')
  w.hands.draw('right', 1)
}

// --- the kick: a shot jolts what the hand holds, and it settles ---------------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.at(1, 1.4, 0)
  w.hands.update(1 / 60, w.head)
  const frame = () => {
    const m = w.hands.heldFrame('right', new THREE.Matrix4())
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    m.decompose(p, q, s)
    // The centre, not the origin: the box's origin is (0, -0.1, 0) of it, scaled.
    return { c: new THREE.Vector3(0, 0.1, 0).applyMatrix4(m), fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(q), s: s.x }
  }
  const rest = frame()
  w.hands.kick('right')
  w.hands.update(1e-6, w.head)
  const peak = frame()
  check(Math.abs(peak.s - rest.s * (1 + KICK_GROW)) < 1e-4, `a kick grows the held thing ${KICK_GROW * 100}%`, `${rest.s.toFixed(4)} -> ${peak.s.toFixed(4)}`)
  check(Math.abs(peak.c.z - rest.c.z - KICK_BACK * 0.2 * Math.cos(KICK_FLIP)) < 1e-4 && peak.c.z > rest.c.z, 'and pushes it back along its own +Z, its size times KICK_BACK', `dz ${(peak.c.z - rest.c.z).toFixed(4)}`)
  check(Math.abs(Math.asin(peak.fwd.y) - KICK_FLIP) < 1e-4, 'and flips its -Z end up', `${peak.fwd.y.toFixed(4)}`)
  w.run(KICK_S / 2)
  const half = frame()
  check(half.s > rest.s && half.s < peak.s && half.c.z > rest.c.z && half.c.z < peak.c.z, 'halfway through, it is on its way back')
  w.run(KICK_S / 2 + 0.02)
  const after = frame()
  check(Math.abs(after.s - rest.s) < 1e-9 && after.c.distanceTo(rest.c) < 1e-9 && Math.abs(after.fwd.y) < 1e-9, `by ${KICK_S * 1000} ms it is back where and as big as it was`)
  const pool = w.hands.pools.get(geo)
  const drawn = new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().fromArray(pool.over.mesh.instanceMatrix.array, 0)).x
  w.hands.kick('right')
  w.hands.update(1e-6, w.head)
  const kicked = new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().fromArray(pool.over.mesh.instanceMatrix.array, 0)).x
  check(Math.abs(kicked - drawn * (1 + KICK_GROW)) < 1e-4, 'the pool draws the kick, as heldFrame reports it')
}

// --- the drop: the source first, then the fall, the roll, the stop --------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.at(10, 1.5, 0)
  w.hands.update(1 / 60, w.head)
  w.hands.drop('right', w.head)
  check(w.src.releases.length === 1 && Math.abs(w.src.releases[0].x - 10) < 1e-6 && w.src.releases[0].head.yaw === 0, 'the source is offered the thing at the hand first')
  check(w.hands.loose.length === 1 && w.hands.loose[0].state === 'fall', 'refused, it is loose and falling')
  const item = w.hands.loose[0]
  const y0 = item.y
  w.run(0.25)
  check(item.y < y0 - 0.2 && item.state === 'fall', 'it falls under gravity', `${(y0 - item.y).toFixed(3)} m in 0.25 s`)
  // 4.5 m to the ground: under a second.
  w.run(1)
  check(item.state === 'roll' && Math.abs(item.y - (groundAt(item.x) + item.r)) < 1e-6, 'it lands on the ground and rolls', `state ${item.state}`)
  check(w.thuds.length === 1 && Math.abs(w.thuds[0].x - 10) < 1e-6 && Math.abs(w.thuds[0].y - groundAt(10)) < 1e-6, 'and is heard meeting the ground, there', JSON.stringify(w.thuds))
  check(w.src.releases.length === 2 && Math.abs(w.src.releases[1].y - groundAt(10)) < 1e-6, 'the source was offered it again at the ground')
  const speeds = []
  const times = []
  const sample = (s) => { for (let t = 0; t < s && item.state === 'roll'; t += 1 / 60) { w.hands.update(1 / 60, w.head); speeds.push(Math.hypot(item.vx, item.vz)); times.push(item.t) } }
  const x1 = item.x, z1 = item.z
  const kick = Math.hypot(item.vx, item.vz)
  check(kick >= ROLL_KICK[0] && kick <= ROLL_KICK[1], `the landing kicks it off at ROLL_KICK ${ROLL_KICK} m/s`, `${kick.toFixed(3)} m/s`)
  sample(0.5)
  check(item.x > x1 + 0.05, 'it rolls downhill, +x on this slope', `${(item.x - x1).toFixed(3)} m in 0.5 s`)
  const q0 = item.q.clone()
  const dir = new THREE.Vector3(item.vx, 0, item.vz).normalize()
  const across = new THREE.Vector3(dir.z, 0, -dir.x)
  // A few frames only: the pull bends the heading, and a long sample's turns no longer share an axis.
  sample(0.05)
  check(item.q.angleTo(q0) > 0.1, 'and turns as it rolls', `${item.q.angleTo(q0).toFixed(2)} rad in 0.05 s`)
  // The turn's sense: the point that was on top has moved the way the ball went, not across it.
  const top = new THREE.Vector3(0, 1, 0).applyQuaternion(q0.clone().invert()).applyQuaternion(item.q)
  check(top.dot(dir) > 0.05 && Math.abs(top.dot(across)) < top.dot(dir) / 4, 'its top rolls forward, the way it travels', `along ${top.dot(dir).toFixed(2)} across ${top.dot(across).toFixed(2)}`)
  // The speed: up while the slope pulls, then down to a stop well short of ROLL_MAX_S, the resistance taking it.
  sample(ROLL_MAX_S)
  const peak = speeds.indexOf(Math.max(...speeds))
  const eased = speeds.slice(peak).every((v, i, a) => i === 0 || v <= a[i - 1])
  check(item.state === 'still' && times[times.length - 1] < ROLL_MAX_S - 1, `it stops on its own before ROLL_MAX_S ${ROLL_MAX_S} s`, `still at ${times[times.length - 1]?.toFixed(2)} s`)
  check(peak > 0 && times[peak] < ROLL_S && eased && speeds[speeds.length - 1] < speeds[peak] / 4, `its speed rises under the slope's fading pull (ROLL_S ${ROLL_S}) and then only falls`, `peak ${speeds[peak]?.toFixed(3)} m/s at ${times[peak]?.toFixed(2)} s, last ${speeds[speeds.length - 1]?.toFixed(3)}`)
  const xs = item.x
  w.run(2)
  check(item.x === xs && w.hands.loose.length === 1 && w.hands.pools.get(geo).mesh.count === 1, 'and stays where it stopped, still drawn')
  // Lying there it is hers again: the hand at it takes it back without asking the bed.
  w.at(item.x, item.y, item.z)
  const asked = w.src.taken.length
  check(w.hands.press('right', w.head) === 'pick' && w.hands.holding('right') === item.rec && w.hands.loose.length === 0 && w.src.taken.length === asked && w.hands.stats.taken === 2, 'a dropped thing is picked up again, the bed not asked')
  w.hands.update(1 / 60, w.head)
  check(w.hands.pools.get(geo).over.mesh.count === 1 && w.hands.pools.get(geo).mesh.count === 0 && item.state === 'held', 'and drawn once, at the hand, on the over mesh')
  check(w.hands.drop('right', w.head) === 'drop' && w.hands.loose.length === 1 && w.hands.loose[0] === item && item.state === 'fall', 'and dropped again')
  const slopeRun = Math.hypot(item.x - x1, item.z - z1)
  // Flat ground: the kick alone, half a metre at least, and the roll stops early. Several drops, since the heading and the kick are rolled.
  const runs = []
  for (let i = 0; i < 6; i++) {
    const f = build()
    f.hands.rand = mulberry32(100 + i)
    f.at(0, 0.3, 0)
    f.hands.press('right', f.head)
    f.at(-5, 1, 0)
    f.hands.update(1 / 60, f.head)
    f.hands.drop('right', f.head)
    f.run(3)
    const it = f.hands.loose[0]
    runs.push({ state: it.state, d: Math.hypot(it.x + 5, it.z), a: Math.atan2(it.z, it.x + 5) })
  }
  check(runs.every((r) => r.state === 'still' && r.d >= 0.5 && r.d < 1.2), 'on the flat it lands, rolls at least half a metre and stops', runs.map((r) => `${r.d.toFixed(2)} m`).join(' '))
  const spread = Math.max(...runs.map((r) => r.a)) - Math.min(...runs.map((r) => r.a))
  check(spread > Math.PI / 2, 'in a direction rolled each time', `${runs.map((r) => (r.a * 180 / Math.PI).toFixed(0)).join(' ')} deg`)
  check(slopeRun > Math.max(...runs.map((r) => r.d)), 'and farther down the slope than on the flat', `slope ${slopeRun.toFixed(2)} m`)
}

// --- a press down a ray: what a desktop click takes ---------------------------------
{
  const w = build()
  w.src.things.length = 0
  w.src.things.push(thing('mushroom', 1.5, 1.6, 0.1, 0.2), thing('mushroom', 1, 1.6, 0.6, 0.2), thing('mushroom', 3, 1.6, 0, 0.2))
  const origin = { x: 0, y: 1.6, z: 0 }
  const dir = { x: 1, y: 0, z: 0 }
  let bad = false
  try { w.hands.pressRay('right', origin, dir, 0, w.head) } catch { bad = true }
  check(bad, 'a ray without a reach throws')
  check(w.hands.pressRay('right', origin, dir, 1.2, w.head) === null && w.src.taken.length === 0, 'nothing within reach along the ray: nothing taken', `${w.src.taken.length}`)
  check(w.hands.pressRay('right', origin, dir, 2, w.head) === 'pick' && w.src.taken[0].x === 1.5, `the first thing whose surface is within RAY_STEP ${RAY_STEP} of the ray is taken, not one beside it`, `took x ${w.src.taken[0]?.x} z ${w.src.taken[0]?.z}`)
  check(w.hands.pressRay('right', origin, dir, 2, w.head) === null && w.hands.loose.length === 0 && w.hands.holding('right') !== null, 'a click with a full hand drops nothing')
  check(w.hands.drop('right', w.head) === 'drop' && w.hands.loose.length === 1, 'the drop lets it go')
  w.run(2)
  check(w.hands.pressRay('right', origin, dir, 4, w.head) === 'pick' && w.src.taken.length === 2 && w.src.taken[1].x === 3, 'and the reach goes as far as it is told', `took x ${w.src.taken[1]?.x}`)
  w.hands.drop('right', w.head)
  w.run(3)
  const loose = w.hands.loose.find((it) => it.state === 'still')
  const asked = w.src.taken.length
  check(loose !== undefined && w.hands.pressRay('right', { x: loose.x - 1, y: loose.y, z: loose.z }, dir, 2, w.head) === 'pick' && w.hands.loose.length === 1 && w.hands.holding('right') !== null && w.src.taken.length === asked, 'a loose thing on the ground is taken down a ray too, the bed not asked')
}

// --- a creature the source takes back leaves the hands ----------------------------
{
  const w = build()
  w.src.takeBack = (rec) => rec.kind === 'crab'
  w.at(4, 0.7, 0)
  w.hands.press('right', w.head)
  w.hands.drop('right', w.head)
  check(w.hands.loose.length === 0 && w.hands.pools.get(geo).items.length === 0, 'a crab let go of is the layer\'s again, not loose here')
  check(w.thuds.length === 0, 'taken at the hand, it never met the ground: no thud', `${w.thuds.length}`)
  w.hands.update(1 / 60, w.head)
  check(w.hands.pools.get(geo).mesh.count === 0, 'and its pool draws nothing')
}

// --- a fish: taken back at the lake's surface, or beached and flapping ----------
{
  const w = build()
  w.src.takeBack = (rec, x, y, z) => rec.kind === 'fish' && y <= water.levelAt(x, z)
  w.at(2, 0.4, 0)
  w.hands.press('right', w.head)
  w.at(35, LEVEL + 2, 0)
  w.hands.update(1 / 60, w.head)
  w.hands.drop('right', w.head)
  check(w.hands.loose.length === 1 && w.src.releases.length === 1, 'over the lake the fish is refused in the air and falls')
  w.run(1)
  check(w.hands.loose.length === 0 && w.src.releases.length === 2 && w.src.releases[1].y <= LEVEL && w.src.releases[1].y > LEVEL - 0.3, 'and taken back as it meets the surface', `offered at y ${w.src.releases[1]?.y.toFixed(3)} level ${LEVEL}`)
  // Beached.
  const b = build()
  b.at(2, 0.4, 0)
  b.hands.press('right', b.head)
  b.at(-3, 1.2, 0)
  b.hands.update(1 / 60, b.head)
  b.hands.drop('right', b.head)
  b.run(1)
  const fish = b.hands.loose[0]
  check(fish && fish.state === 'flap', 'on dry ground it lands flapping', `state ${fish?.state}`)
  const swim = () => b.hands.pools.get(geo).geo.getAttribute('aSwim').array
  check(swim()[1] > 0.05 && Math.abs(fish.q.angleTo(new THREE.Quaternion()) - Math.PI / 2) < 1e-6, 'on its side, its tail beating hard', `amp ${swim()[1].toFixed(3)}`)
  // The nose lies along local z; on its side that is still horizontal, so a jerk about the vertical turns it.
  const yaw0 = new THREE.Vector3(0, 0, 1).applyQuaternion(fish.q)
  b.run(3)
  const yaw1 = new THREE.Vector3(0, 0, 1).applyQuaternion(fish.q)
  check(yaw0.angleTo(yaw1) > 0.05, 'and jerking about', `${yaw0.angleTo(yaw1).toFixed(2)} rad in 3 s`)
  const full = swim()[1]
  b.run(FLAP_S - 4 + FLAP_FADE_S / 2)
  check(fish.state === 'flap' && swim()[1] < full * 0.8, `weaker after FLAP_S ${FLAP_S} s`, `${swim()[1].toFixed(3)} of ${full.toFixed(3)}`)
  b.run(FLAP_FADE_S)
  check(fish.state === 'still' && swim()[1] === 0 && Math.abs(fish.x + 3) < 0.6, `and still after FLAP_FADE_S ${FLAP_FADE_S} more, near where it fell`, `x ${fish.x.toFixed(2)}`)
}

// --- afloat: anything but a fish or a crab let go over water ----------------------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.at(40, LEVEL + 1.5, 0)
  w.hands.update(1 / 60, w.head)
  w.hands.drop('right', w.head)
  const m = w.hands.loose[0]
  w.run(0.8)
  check(m.state === 'float' && w.src.releases.length === 2 && w.src.releases[1].y <= LEVEL, 'over the lake a mushroom is offered back at the surface and, refused, floats', `state ${m.state}`)
  w.run(2)
  const line = LEVEL + m.r * 0.2
  check(Math.abs(m.y - line) < 0.03 && m.y > LEVEL, 'settled on the line, its centre a little over the water', `y ${m.y.toFixed(3)} line ${line.toFixed(3)}`)
  check(w.thuds.length === 0, 'without a thud')
  check(w.splashes.length === 1 && Math.abs(w.splashes[0].x - 40) < 1e-6 && w.splashes[0].y === LEVEL, 'and heard splashing in, at the surface', JSON.stringify(w.splashes))
  const ys = []
  for (let t = 0; t < 4; t += 1 / 60) { w.hands.update(1 / 60, w.head); ys.push(m.y) }
  check(Math.max(...ys) - Math.min(...ys) > 0.02 && Math.max(...ys) - Math.min(...ys) < 0.06 && ys.every((y) => Math.abs(y - line) < 0.03), 'and bobbing on it', `swing ${(Math.max(...ys) - Math.min(...ys)).toFixed(3)} m`)
  const heading = new THREE.Vector3(1, 0, 0).applyQuaternion(m.q)
  const q0 = m.q.clone()
  w.run(2)
  const turned = new THREE.Vector3(1, 0, 0).applyQuaternion(m.q)
  const rate = m.q.angleTo(q0) / 2
  check(Math.abs(turned.y) < 1e-6 && rate > 0.1 && rate < 0.5 && heading.angleTo(turned) > 0.2, 'turning slowly about the vertical', `${rate.toFixed(2)} rad/s`)
  const x0 = m.x, z0 = m.z
  w.run(10)
  const moved = Math.hypot(m.x - x0, m.z - z0)
  check(moved > 0.05 && moved < 1 && m.state === 'float' && w.hands.loose.length === 1, 'drifting slowly, still afloat and still here', `${moved.toFixed(2)} m in 10 s`)
  // It is hers again from the water.
  w.at(m.x, m.y, m.z)
  check(w.hands.press('right', w.head) === 'pick' && w.hands.holding('right') === m.rec && w.hands.loose.length === 0, 'and picked out of the water')
  // Let go under the water: it rises to the line, slowly.
  w.at(40, LEVEL - 1.5, 0)
  w.hands.update(1 / 60, w.head)
  w.hands.drop('right', w.head)
  w.run(0.5)
  const deep = m.y
  check(m.state === 'float' && deep < LEVEL - 1 && deep > LEVEL - 1.5, 'let go under the water it floats up', `y ${deep.toFixed(2)} after 0.5 s`)
  check(w.splashes.length === 1, 'never having been above it, without a splash', `${w.splashes.length} splashes`)
  w.run(2)
  check(m.y > deep + 0.4 && m.y < line - 0.2, 'slowly', `y ${m.y.toFixed(2)} after 2.5 s`)
  w.run(4)
  check(Math.abs(m.y - line) < 0.03, 'to the line', `y ${m.y.toFixed(3)}`)
  // The bank: a heading for the shore turns back at it.
  m.x = 30.2; m.z = 0
  m.ax = -0.06; m.az = 0; m.vx = -0.06; m.vz = 0; m.tack = 30
  w.run(10)
  check(m.x > 30 && m.state === 'float' && water.levelAt(m.x, m.z) !== null, 'it never drifts up the beach', `x ${m.x.toFixed(2)}`)
  // A crab refused at the surface goes on down to the bed as before.
  const c = build()
  c.at(4, 0.7, 0)
  c.hands.press('right', c.head)
  c.at(35, LEVEL + 1, 0)
  c.hands.update(1 / 60, c.head)
  c.hands.drop('right', c.head)
  c.run(3)
  const crab = c.hands.loose[0]
  check(crab.state !== 'float' && Math.abs(crab.y - (groundAt(crab.x) + crab.r)) < 1e-6 && c.thuds.length === 1 && c.thuds[0].y < LEVEL, 'a crab refused at the surface sinks to the bed, and is heard there', `state ${crab.state} y ${crab.y.toFixed(2)} thuds ${c.thuds.length}`)
}

// --- the backpack zone and the buzz ------------------------------------------------
{
  const w = build()
  const behind = (dx = 0) => w.at(0 + dx, 1.6 + 0.1, -0.3)
  const ahead = () => w.at(0, 1.2, 0.4)
  // Empty hand: the zone is silent.
  behind()
  w.hands.update(1 / 60, w.head)
  ahead()
  w.hands.update(1 / 60, w.head)
  check(w.pulses.length === 0, 'an empty hand crossing the shoulder does not buzz')
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  ahead()
  w.hands.update(1 / 60, w.head)
  behind()
  w.hands.update(1 / 60, w.head)
  w.hands.update(1 / 60, w.head)
  check(w.pulses.length === 1 && w.pulses[0].key === 'right' && w.pulses[0].i === ZONE_PULSE[0] && w.pulses[0].ms === ZONE_PULSE[1], 'a full hand buzzes once as it enters the zone', JSON.stringify(w.pulses))
  ahead()
  w.hands.update(1 / 60, w.head)
  behind()
  w.hands.update(1 / 60, w.head)
  check(w.pulses.length === 2, 'and again on the next entry')
  // Facing +x: yaw = pi/2, so behind is -x.
  w.head.yaw = Math.PI / 2
  w.at(-0.3, 1.7, 0)
  w.hands.update(1 / 60, w.head)
  check(w.pulses.length === 2, 'the zone turns with her head: still in it, no new buzz')
  w.at(0.3, 1.7, 0)
  w.hands.update(1 / 60, w.head)
  w.at(-0.3, 1.7, 0)
  w.hands.update(1 / 60, w.head)
  check(w.pulses.length === 3, 'ahead of her is out of it, behind is back in')
  w.head.yaw = 0
  // Its edges.
  w.at(0, 1.6 - ZONE.below - 0.05, -0.3)
  w.hands.update(1 / 60, w.head)
  w.at(0, 1.6 - ZONE.below + 0.05, -0.3)
  w.hands.update(1 / 60, w.head)
  check(w.pulses.length === 4, `under ZONE.below ${ZONE.below} m is out, above it in`)
  w.at(0, 1.7, -ZONE.within - 0.1)
  w.hands.update(1 / 60, w.head)
  check(w.hands.hands.get('right').inZone === false, `past ZONE.within ${ZONE.within} m is out`)
  // The stow.
  behind()
  w.hands.update(1 / 60, w.head)
  check(w.hands.press('right', w.head) === 'stow' && w.pack.length === 1 && w.pack[0].kind === 'mushroom' && w.hands.holding('right') === null && w.hands.loose.length === 0, 'the trigger in the zone stows the thing')
  // Full pack: it stays in the hand.
  w.setRoom(1)
  w.at(2, 0.4, 0)
  w.hands.press('right', w.head)
  behind(2)
  w.head.x = 2
  w.hands.update(1 / 60, w.head)
  check(w.hands.press('right', w.head) === 'full' && w.hands.holding('right')?.kind === 'fish', 'with the backpack full the thing stays in the hand')
  // The desktop's key.
  w.setRoom(2)
  check(w.hands.stowPress('right') === 'stow' && w.pack.length === 2, 'stowPress stows without the zone')
  check(w.hands.stowPress('right') === null, 'and is null with nothing held')
  // Unstowable in the zone: dropped.
  w.at(4, 0.7, 0)
  w.hands.press('right', w.head)
  w.head.x = 4
  behind(4)
  w.hands.update(1 / 60, w.head)
  // Six: the re-entry before the stow and the fish on its way in, above.
  check(w.pulses.length === 6, 'a crab its source calls unstowable does not buzz in the zone', `${w.pulses.length}`)
  check(w.hands.drop('right', w.head) === 'drop' && w.pack.length === 2 && w.hands.loose.length === 1, 'and the grip there drops it')
}

// --- the packed slot, and its way back into a hand ----------------------------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  const rec = w.hands.holding('right')
  const slot = w.hands.pack(rec)
  check(!('geometry' in slot) && !('material' in slot) && slot.kind === 'mushroom' && slot.size === 0.2 && slot.stowable === true, 'a packed slot is the record without its geometry and material')
  check(slot.attrs.aSwim !== rec.attrs.aSwim && slot.color !== rec.color && slot.scale !== rec.scale && JSON.stringify(JSON.parse(JSON.stringify(slot))) === JSON.stringify(slot), 'its arrays its own copies, and it survives the save as JSON')
  let shape = false
  try { w.hands.pack({ kind: 'x' }) } catch { shape = true }
  check(shape, 'packing a bad record throws')
  const saved = JSON.parse(JSON.stringify(slot))
  const back = w.hands.dressed(saved)
  check(back.geometry === geo && back.material === material && back.kind === 'mushroom' && back.attrs.aSwim[3] === 4, 'dressed, a slot is a record again on its source\'s geometry and material')
  w.src.landed = false
  check(w.hands.dressed(saved) === null, 'or null while the source has not landed its asset')
  let unknown = false
  try { w.hands.dressed({ ...saved, kind: 'dragon' }) } catch (e) { unknown = /dragon/.test(e.message) }
  check(unknown, 'a slot of a kind no source hands out throws, naming it')
  let early = false
  try { w.hands.give('right', saved, w.head) } catch { early = true }
  check(early && w.hands.holding('right') === rec && w.hands.loose.length === 0, 'given before the asset lands it throws, the hand unchanged')
  w.src.landed = true
  // Into a full hand: what it held is let go first.
  w.at(3, 1.4, 0)
  w.hands.give('right', saved, w.head)
  const held = w.hands.holding('right')
  check(held !== rec && held.kind === 'mushroom' && held.geometry === geo && w.hands.loose.length === 1 && w.hands.loose[0].rec === rec && w.hands.loose[0].state === 'fall' && w.hands.stats.dropped === 1, 'given to a full hand, the slot is held and what was held falls at the hand')
  w.hands.update(1 / 60, w.head)
  check(w.hands.pools.get(geo).mesh.count === 1 && w.hands.pools.get(geo).over.mesh.count === 1, 'both drawn, the held one over')
  // Into an empty hand: nothing falls.
  w.hands.stowPress('right')
  w.hands.give('right', saved, w.head)
  check(w.hands.holding('right')?.kind === 'mushroom' && w.hands.loose.length === 1 && w.hands.stats.dropped === 1, 'given to an empty hand, nothing falls')
  // In the zone the given thing stows like any other.
  w.at(0, 1.7, -0.3)
  w.hands.update(1 / 60, w.head)
  check(w.hands.press('right', w.head) === 'stow' && w.pack.length === 2, 'and it stows again')
  // put: the held thing packed for a slot of the menu's choosing, the hand emptied.
  check(w.hands.put('right') === null, 'put is null with nothing held')
  w.hands.give('right', saved, w.head)
  const stowed = w.hands.stats.stowed
  const put = w.hands.put('right')
  check(put !== null && put.kind === 'mushroom' && !('geometry' in put) && w.hands.holding('right') === null && w.hands.stats.stowed === stowed + 1 && w.pack.length === 2 && w.hands.pools.get(geo).items.length === 1, 'put hands back the held thing packed, the hand empty, the backpack callback not asked')
  w.at(4, 0.7, 0)
  w.hands.press('right', w.head)
  check(w.hands.put('right') === null && w.hands.holding('right')?.kind === 'crab', 'and null for a thing its source calls unstowable, still held')
}

// --- the photograph -------------------------------------------------------------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  const slot = w.hands.pack(w.hands.holding('right'))
  const log = []
  const target = new THREE.WebGLRenderTarget(768, 384)
  const clear = new THREE.Color(0x203040)
  const renderer = {
    xr: { enabled: true },
    target: null,
    getRenderTarget() { return this.target },
    setRenderTarget(t) { this.target = t; log.push(['target', t]) },
    getClearColor(c) { return c.copy(clear) },
    getClearAlpha() { return 1 },
    setClearColor(c, a) { clear.set(c); log.push(['clear', clear.getHex(), a]) },
    // The canvas's own viewport and scissor, as three keeps them: setRenderTarget(null) puts the canvas back to whatever these last were, scaled by the pixel ratio.
    viewport: new THREE.Vector4(0, 0, 1280, 720),
    scissor: new THREE.Vector4(0, 0, 1280, 720),
    scissorTest: false,
    setViewport(x, y, w, h) { if (x.isVector4) this.viewport.copy(x); else this.viewport.set(x, y, w, h); log.push(['viewport', ...this.viewport.toArray()]) },
    setScissor(x, y, w, h) { if (x.isVector4) this.scissor.copy(x); else this.scissor.set(x, y, w, h); log.push(['scissor', ...this.scissor.toArray()]) },
    setScissorTest(on) { this.scissorTest = on; log.push(['scissorTest', on]) },
    clear(c, d, s) { log.push(['cleared', this.xr.enabled, this.target === target]) },
    render(scene, cam) { log.push(['render', scene, cam, this.xr.enabled, this.target === target]) },
  }
  const rect = { x: 192, y: 0, w: 192, h: 192 }
  check(w.hands.photograph(renderer, slot, target, rect) === true, 'a landed slot is photographed')
  const render = log.find((e) => e[0] === 'render')
  const cleared = log.find((e) => e[0] === 'cleared')
  check(render && render[3] === false && render[4] === true && cleared[1] === false && cleared[2] === true, 'cleared and rendered into the target with XR off')
  // The rect on the target itself, in its pixels, which setRenderTarget applies: three scales renderer.setViewport/setScissor by the pixel ratio and copies them back onto the canvas at setRenderTarget(null), which shrank the desktop view into a cell of the atlas.
  const targetSet = log.findIndex((e) => e[0] === 'target' && e[1] === target)
  check(targetSet >= 0 && target.viewport.equals(new THREE.Vector4(192, 0, 192, 192)) && target.scissor.equals(target.viewport) && target.scissorTest === true, "within the rect, set as the target's own")
  check(!log.some((e) => e[0] === 'viewport' || e[0] === 'scissor' || e[0] === 'scissorTest') && renderer.viewport.equals(new THREE.Vector4(0, 0, 1280, 720)) && renderer.scissor.equals(new THREE.Vector4(0, 0, 1280, 720)) && renderer.scissorTest === false, "and never through the renderer's, the canvas's own untouched", `viewport ${renderer.viewport.toArray()} scissor ${renderer.scissor.toArray()}`)
  check(renderer.target === null && renderer.xr.enabled === true && clear.getHex() === 0x203040 && log.some((e) => e[0] === 'clear' && e[2] === 1), 'and the target, XR and the clear colour put back')
  const scene = render[1]
  const cam = render[2]
  const lights = scene.children.filter((o) => o.isLight)
  check(lights.length === 2 && lights.some((l) => l.isDirectionalLight) && lights.some((l) => l.isHemisphereLight) && scene.fog?.isFogExp2 && scene.fog.density === 0, 'the studio has one sun, one sky and a fog of no density, the world\'s program')
  const subject = w.hands.studio.subjects.get(geo)
  check(subject && subject.mesh.material === material && subject.mesh.count === 1 && scene.children.includes(subject.mesh) === false, 'the subject is one instance on the source\'s material, in the studio only for the shot')
  const m = new THREE.Matrix4().fromArray(subject.mesh.instanceMatrix.array, 0)
  const centre = subject.geo.boundingBox.getCenter(new THREE.Vector3()).multiplyScalar(0.2)
  const p = new THREE.Vector3().setFromMatrixPosition(m)
  check(p.clone().add(centre).length() < 1e-6 && Math.abs(new THREE.Vector3().setFromMatrixScale(m).x - 0.2) < 1e-6, 'its scaled box centred on the origin', `${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)}`)
  const r = subject.geo.boundingBox.getSize(new THREE.Vector3()).multiplyScalar(0.2).length() / 2
  check(cam.isOrthographicCamera && cam.right > r && cam.right < r * 1.2 && cam.position.y > 0 && cam.position.z > 0 && cam.position.length() > r, 'framed orthographically a little wider than its diagonal, from the front and above', `half ${cam.right.toFixed(3)} for ${r.toFixed(3)}`)
  check(subject.mesh.instanceColor.array[0] === 0.5 && subject.geo.getAttribute('aSwim').array[3] === 4, 'in its own tint and attributes')
  // The same geometry again: the same subject.
  w.hands.photograph(renderer, slot, target, rect)
  check(w.hands.studio.subjects.size === 1, 'one subject a geometry')
  // A null slot clears the rect and draws nothing.
  log.length = 0
  check(w.hands.photograph(renderer, null, target, rect) === false && log.some((e) => e[0] === 'cleared') && !log.some((e) => e[0] === 'render'), 'a null slot clears its rect without a render')
  // Not landed: cleared, false.
  log.length = 0
  w.src.landed = false
  check(w.hands.photograph(renderer, slot, target, rect) === false && log.some((e) => e[0] === 'cleared') && !log.some((e) => e[0] === 'render') && renderer.target === null, 'a slot whose asset has not landed is cleared and false')
}

// --- the loose cap ----------------------------------------------------------------
{
  const w = build()
  w.src.things = []
  for (let i = 0; i < LOOSE_MAX + 5; i++) w.src.things.push(thing('mushroom', -10 - i, 0, 0, 0.2))
  for (let i = 0; i < LOOSE_MAX + 5; i++) {
    w.at(-10 - i, 0.3, 0)
    w.hands.press('right', w.head)
    w.hands.drop('right', w.head)
  }
  w.hands.update(1 / 60, w.head)
  const pool = w.hands.pools.get(geo)
  check(w.hands.loose.length === LOOSE_MAX && pool.items.length === LOOSE_MAX && pool.mesh.count === LOOSE_MAX, `at most LOOSE_MAX ${LOOSE_MAX} loose things`, `${w.hands.loose.length}`)
  check(Math.abs(w.hands.loose[0].x + 15) < 1e-6, 'the oldest were forgotten first', `oldest at x ${w.hands.loose[0].x}`)
  check(w.hands.stats.taken === LOOSE_MAX + 5 && w.hands.stats.dropped === LOOSE_MAX + 5, 'the counts kept every take and drop')
}

// --- the room hears of her hands ---------------------------------------------------
{
  const w = build()
  const events = []
  w.hands.sync = (e) => events.push(e)
  w.hands.tag = '0123abcd'
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  check(events.length === 1 && events[0].type === 'hold' && events[0].hand === 'right' && events[0].slot?.kind === 'mushroom' && !('geometry' in events[0].slot), 'a take is one hold event with the packed slot')
  events.length = 0
  w.hands.drop('right', w.head)
  check(events.length === 2 && events[0].type === 'hold' && events[0].slot === null && events[1].type === 'loose' && events[1].id === '0123abcd-0' && events[1].state === 2 && events[1].pose.length === 7, 'a drop is a hold of nothing and one loose thing in motion, under the tag and a count', JSON.stringify(events.map((e) => e.type)))
  events.length = 0
  w.run(0.5)
  check(events.length === 0, 'nothing is sent while it falls and rolls')
  w.run(ROLL_MAX_S + 1)
  const item = w.hands.loose[0]
  check(events.length === 1 && events[0].type === 'loose' && events[0].id === '0123abcd-0' && events[0].state === 0 && Math.abs(events[0].pose[0] - item.x) < 1e-9 && Math.abs(events[0].pose[1] - item.y) < 1e-9, 'at rest it is sent once more, still, where it lies', JSON.stringify(events))
  check(item.mine === false, 'and it is hers to settle no longer')
  const all = w.hands.looseEvents()
  check(all.length === 1 && all[0].id === '0123abcd-0' && all[0].state === 0, 'looseEvents lists it for a relay that has just named her')
  // Picked up again: a lift, and its next drop is a new id.
  events.length = 0
  w.at(item.x, item.y, item.z)
  w.hands.press('right', w.head)
  check(events.length === 2 && events[0].type === 'lift' && events[0].id === '0123abcd-0' && events[1].type === 'hold', 'taking it back is a lift then a hold', JSON.stringify(events.map((e) => e.type)))
  events.length = 0
  w.hands.drop('right', w.head)
  check(events[1]?.type === 'loose' && events[1].id === '0123abcd-1', 'dropped again it is a new thing to the room', events[1]?.id)
  // Stowed from the hand: a hold of nothing; given from the backpack: a hold.
  w.run(ROLL_MAX_S + 1)
  w.at(w.hands.loose[0].x, w.hands.loose[0].y, w.hands.loose[0].z)
  w.hands.press('right', w.head)
  events.length = 0
  w.at(0, 1.7, -0.3)
  w.hands.update(1 / 60, w.head)
  w.hands.press('right', w.head)
  check(w.pack.length === 1 && events.length === 1 && events[0].type === 'hold' && events[0].slot === null, 'stowing is a hold of nothing', JSON.stringify(events))
  events.length = 0
  w.hands.give('right', w.pack.pop(), w.head)
  check(events.length === 1 && events[0].type === 'hold' && events[0].slot?.kind === 'mushroom', 'taking from the backpack is a hold')
  // Without a tag no loose thing has an id and nothing is said of it; looseEvents names it once there is one.
  const h2 = build()
  const e2 = []
  h2.hands.sync = (e) => e2.push(e)
  h2.at(0, 0.3, 0)
  h2.hands.press('right', h2.head)
  h2.hands.drop('right', h2.head)
  h2.run(ROLL_MAX_S + 1)
  check(e2.every((e) => e.type === 'hold') && h2.hands.loose[0].netId === null, 'before the relay names her a drop is a hold alone')
  let noTag = false
  try { h2.hands.looseEvents() } catch { noTag = true }
  h2.hands.tag = 'deadbeef'
  const named = h2.hands.looseEvents()
  check(noTag && named.length === 1 && named[0].id === 'deadbeef-0' && h2.hands.loose[0].netId === 'deadbeef-0', 'looseEvents throws without a tag and names the thing once there is one')
}

// --- the room's things here ------------------------------------------------------------
{
  const w = build()
  const events = []
  w.hands.sync = (e) => events.push(e)
  w.hands.tag = '0123abcd'
  const slot = { kind: 'mushroom', name: 'mushroom', size: 0.2, attrs: { aSwim: [1, 2, 3, 4] }, color: [0.5, 0.6, 0.7], scale: [0.2, 0.2, 0.2], stowable: true }
  const pool = () => w.hands.pools.get(geo)
  // A peer's thing in motion falls and rolls here on its own; its rest is the peer's word, eased onto.
  check(w.hands.netLoose('ffff0000-1', slot, [-5, 1, 0, 0, 0, 0, 1], 2) === true && w.hands.loose.length === 1 && w.hands.loose[0].state === 'fall' && w.hands.loose[0].mine === false, 'a peer loose thing in motion appears here falling')
  w.run(ROLL_MAX_S + 1)
  const peerItem = w.hands.loose[0]
  check(peerItem.state === 'still' && events.length === 0, 'it comes to rest here and nothing is said of it', `${peerItem.state} ${events.length}`)
  w.hands.netLoose('ffff0000-1', slot, [-5.5, groundAt(-5.5) + 0.1, 0.3, 0, 0, 0, 1], 0)
  check(peerItem.state === 'ease' && peerItem.eState === 'still', 'the peer\'s rest pose is eased onto')
  w.run(EASE_S / 2)
  check(peerItem.state === 'ease' && Math.abs(peerItem.x + 5.5) > 1e-3, 'half way there half way through')
  w.run(EASE_S)
  check(peerItem.state === 'still' && Math.abs(peerItem.x + 5.5) < 1e-6 && Math.abs(peerItem.z - 0.3) < 1e-6, `and there, still, after EASE_S ${EASE_S}`, `${peerItem.x.toFixed(3)} ${peerItem.z.toFixed(3)}`)
  // Afloat: on the lake, drifting.
  w.hands.netLoose('ffff0000-2', slot, [40, LEVEL, 0, 0, 0, 0, 1], 1)
  check(w.hands.loose.length === 2 && w.hands.loose[1].state === 'float', 'a peer thing afloat appears here afloat')
  // Not dressed: false, nothing made.
  w.src.landed = false
  check(w.hands.netLoose('ffff0000-3', slot, [-6, 1, 0, 0, 0, 0, 1], 0) === false && w.hands.loose.length === 2, 'a thing whose source has not landed is refused, to be asked again')
  w.src.landed = true
  // Hers is hers: a peer's word on one of her own things is ignored while it is hers to settle.
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.hands.drop('right', w.head)
  const mine = w.hands.loose[2]
  check(mine.mine && w.hands.netLoose(mine.netId, slot, [9, 9, 9, 0, 0, 0, 1], 0) === true && mine.state === 'fall', 'a peer cannot move what she has just let go')
  // Lifted by a peer: gone from here; an unknown id is nothing.
  w.hands.netLift('ffff0000-2')
  w.hands.netLift('nobody-1')
  check(w.hands.loose.length === 2 && !w.hands.loose.some((i) => i.netId === 'ffff0000-2') && pool().items.length === 2, 'a lift takes the thing out of the world and the pool')
  // Her own thing picked up by a peer while it still rolls: gone, and she says nothing of its rest.
  events.length = 0
  w.hands.netLift(mine.netId)
  w.run(ROLL_MAX_S + 1)
  check(w.hands.loose.length === 1 && events.length === 0, 'her own thing lifted by a peer mid-roll is gone and never reported at rest', `${events.length}`)
  // A peer's hands: a copy each, out of sight until placed, then where the peer's hand is.
  w.hands.netHold('peer-a', 0, slot)
  w.hands.netHold('peer-a', 2, { ...slot, kind: 'crab', name: 'crab', size: 1.5, stowable: false })
  const held = w.hands.peerHeld.get('peer-a')
  check(held.length === 3 && held[0].item?.state === 'peer' && held[0].item.y === UNPLACED_Y && held[1] === null && held[2].item?.rec.kind === 'crab', 'a peer hold makes a copy in the pools, out of sight', `${held[0].item?.y}`)
  check(w.hands.stats.peers === 2, 'the stats count the peers\' copies')
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1)
  w.hands.placePeer('peer-a', 0, 3, 1.2, 4, q)
  w.hands.update(1 / 60, w.head)
  const m = new THREE.Matrix4().fromArray(pool().mesh.instanceMatrix.array, pool().items.indexOf(held[0].item) * 16)
  const pos = new THREE.Vector3().setFromMatrixPosition(m)
  check(Math.abs(pos.x - 3 + held[0].item.off.x) < 1e-6 && Math.abs(pos.z - 4 + held[0].item.off.z) < 1e-6, 'placed, the copy is drawn at the peer\'s hand', `${pos.x.toFixed(3)} ${pos.z.toFixed(3)}`)
  check(held[0].item.q.equals(q), 'in its rotation')
  // Lures: hers by nobody, a placed copy by its peer, an unplaced one not at all.
  const lures = w.hands.lures([])
  const peerLure = lures.find((l) => l.by === 'peer-a')
  check(lures.length === 1 && peerLure && peerLure.kind === 'mushroom' && peerLure.x === 3 && peerLure.y === 1.2 && peerLure.z === 4, 'a placed copy is a lure by its peer, at the copy; the crab copy still out of sight is not', lures.map((l) => `${l.kind} by ${l.by}`).join(', '))
  w.hands.placePeer('peer-a', 2, 5, 1, 5, q)
  check(w.hands.lures([]).length === 2 && w.hands.lures([]).every((l) => l.by === 'peer-a'), 'placed, the crab is one too')
  w.at(2, 0, 0)
  check(w.hands.holding('right') === null && w.hands.press('right', w.head) === 'pick' && w.hands.lures([]).some((l) => l.by === null && l.kind === 'fish'), 'and what her own hand holds is a lure by null: this client\'s to tell the room about')
  w.hands.put('right')
  // Replaced, emptied, gone.
  w.hands.netHold('peer-a', 0, { ...slot, name: 'other' })
  check(held[0].item.rec.name === 'other' && pool().items.length === 3, 'a new slot in the same hand replaces the copy')
  w.hands.netHold('peer-a', 0, null)
  check(held[0] === null && pool().items.length === 2, 'a hold of nothing drops the copy')
  w.hands.placePeer('peer-a', 0, 0, 0, 0, q)
  w.hands.netPeerGone('peer-a')
  w.hands.netPeerGone('peer-b')
  check(!w.hands.peerHeld.has('peer-a') && pool().items.length === 1 && w.hands.stats.peers === 0, 'a peer gone takes its copies with it')
  // Not yet dressed: the copy waits for a later frame.
  w.src.landed = false
  w.hands.netHold('peer-c', 1, slot)
  check(w.hands.peerHeld.get('peer-c')[1].item === null, 'a copy whose source has not landed waits')
  w.src.landed = true
  w.hands.update(1 / 60, w.head)
  check(w.hands.peerHeld.get('peer-c')[1].item?.state === 'peer', 'and is dressed on a later frame')
  let bad = 0
  try { w.hands.netHold('peer-c', 3, slot) } catch { bad++ }
  try { w.hands.netLoose('x', slot, [0, 0, 0], 0) } catch { bad++ }
  try { w.hands.netLoose('x', slot, [0, 0, 0, 0, 0, 0, 1], 5) } catch { bad++ }
  check(bad === 3, 'a fourth hand, a short pose and an unknown state throw', `${bad} of 3`)
  check(POOL_CAP === LOOSE_MAX + 7 * 3 + CARRY_MAX * CARRIERS && OVER_CAP === 3, 'a pool holds the loose things, seven peers\' hands and the carriers\' armfuls; its over mesh her three hands\'', `${POOL_CAP}`)
  // Dispose, with the over group mounted where main.js renders it: a peer's pool whose over mesh was never drawn must not be left there with a nulled array, which the renderer reads on the room's next overlay pass.
  const overlay = new THREE.Scene()
  overlay.add(w.hands.over)
  const pools = [...w.hands.pools.values()]
  const geos = pools.flatMap((p) => [p.geo, p.over.geo])
  let disposed = 0
  for (const g of geos) g.addEventListener('dispose', () => disposed++)
  w.hands.dispose()
  check(w.hands.peerHeld.size === 0, 'dispose forgets the peers')
  check(w.hands.over.parent === null && overlay.children.length === 0, 'dispose takes the over group out of the overlay')
  check(disposed === geos.length && geos.length > 0, 'dispose frees every pool geometry, main and over', `${disposed} of ${geos.length}`)
  check(pools.every((p) => [...p.instanced, ...p.over.instanced].every(({ attr }) => attr.array instanceof Float32Array)), 'and leaves every instanced attribute its array')
}

// --- a record with a bad shape throws --------------------------------------------
{
  const w = build()
  w.src.take = () => ({ kind: 'mushroom', name: 'mushroom', size: 0.2, geometry: geo, material, attrs: { aSwim: [1, 2] }, color: null, scale: [1, 1, 1], stowable: true })
  w.at(0, 0.3, 0)
  let threw = false
  try { w.hands.press('right', w.head) } catch (e) { threw = /aSwim/.test(e.message) }
  check(threw, 'an instanced attribute of the wrong width throws, naming it')
}

// --- the taken registry -----------------------------------------------------------
{
  const t = new Taken()
  t.add('mushroom', 10, 20)
  check(t.has('mushroom', 10.04, 19.96) && !t.has('mushroom', 10.06, 20) && !t.has('carrot', 10, 20), 'a spot is found within 0.05 m under its own kind', `${t.count}`)
  let threw = 0
  for (const bad of [['', 1, 2], ['x', NaN, 2], ['x', 1, undefined]]) { try { t.add(...bad) } catch { threw++ } }
  check(threw === 3, 'a bad entry throws', `${threw} of 3`)
  t.clear()
  check(t.count === 0 && !t.has('mushroom', 10, 20), 'clear empties it')
}

// --- her size (DESIGN.md §30): the reach, the lift cap and the zone are hers ---------
{
  const K = 0.5
  const scene = new THREE.Scene()
  const pulses = []
  const hands = new Hands(scene, { walk, water, haptic: (key) => pulses.push(key), stow: () => true, thud() {}, splash() {}, rand: mulberry32(3), scale: K })
  const src = new Source([thing('mushroom', 0, 0, 0, 0.2), thing('crab', 4, 0, 0, 1.5)])
  hands.addSource(src, ['mushroom', 'crab'])
  const node = new THREE.Group()
  scene.add(node)
  hands.addHand('right', node)
  const head = { x: 0, y: 0.8, z: 0, yaw: 0 }
  const at = (x, y, z) => { node.position.set(x, y, z); node.updateMatrixWorld(true) }
  let threw = false
  try { new Hands(new THREE.Scene(), { walk, water, haptic() {}, stow() {}, thud() {}, splash() {}, scale: 0 }) } catch { threw = true }
  check(threw, 'a scale that is not positive throws')
  at(0, 0.1 + REACH_M * K + 0.02, 0)
  check(hands.press('right', head) === null, 'at half size a thing just past half her reach is out of it', `hand ${(REACH_M * K + 0.02).toFixed(3)} m over a 0.2 m cap`)
  at(0, 0.1 + REACH_M * K - 0.02, 0)
  check(hands.press('right', head) === 'pick' && hands.holding('right').kind === 'mushroom', 'and within it is taken')
  hands.drop('right', head)
  at(4, 0.3, 0)
  check(hands.press('right', head) === null && src.taken.length === 1, `a ${1.5} m crab is past the lift cap at half size`, `cap ${GRAB_MAX_M * K} m`)
  at(0, 0.1 + REACH_M * K - 0.02, 0)
  hands.press('right', head)
  at(0, 0.9, 0.3 * K)
  hands.update(1 / 60, head)
  at(0, 0.9, -ZONE.within * K - 0.05)
  hands.update(1 / 60, head)
  check(pulses.length === 0, 'the zone about her head is half as wide: past it is out')
  at(0, 0.9, -ZONE.within * K + 0.1)
  hands.update(1 / 60, head)
  check(pulses.length === 1 && hands.hands.get('right').inZone, 'and inside it the hand buzzes')
  // Her hand hangs under the rig, which Player scales to her size: the thing in it is turned by the hand, never scaled by the rig.
  hands.drop('right', head)
  src.things.push(thing('mushroom', 20, 0, 0, 0.2))
  const rig = new THREE.Group()
  rig.scale.setScalar(K)
  rig.position.set(20, 0, 0)
  scene.add(rig)
  rig.add(node)
  node.position.set(0, (0.1 + REACH_M * K - 0.02) / K, 0)
  node.updateMatrixWorld(true)
  check(hands.press('right', head) === 'pick', 'a hand under the rig takes a mushroom')
  node.quaternion.setFromEuler(new THREE.Euler(0.7, -1.1, 0.4))
  node.updateMatrixWorld(true)
  hands.update(1 / 60, head)
  const pool = hands.pools.get(geo)
  const m = new THREE.Matrix4().fromArray(pool.over.mesh.instanceMatrix.array, 0)
  const cols = [0, 1, 2].map((i) => new THREE.Vector3().setFromMatrixColumn(m, i))
  const lens = cols.map((c) => c.length())
  check(lens.every((l) => Math.abs(l - 0.2) < 1e-6) && Math.abs(cols[0].dot(cols[1])) < 1e-6 && Math.abs(cols[1].dot(cols[2])) < 1e-6 && Math.abs(cols[0].dot(cols[2])) < 1e-6, 'held under a rig at half size and turned, the thing is only turned: its own size along every axis, the axes square', lens.map((l) => l.toFixed(4)).join(' '))
  check(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(node.matrixWorld)).angleTo(hands.hands.get('right').held.q) < 1e-6, 'and turned as the hand is')
  // A source that never reads maxSize is held to the cap all the same.
  const deaf = new Source([thing('fish', 9, 0, 0, 1.5)])
  deaf.pickAt = function (x, y, z, reach) { return Source.prototype.pickAt.call(this, x, y, z, reach, Infinity) }
  hands.addSource(deaf, 'fish')
  hands.drop('right', head)
  rig.remove(node)
  scene.add(node)
  at(9, 0.3, 0)
  check(hands.press('right', head) === null && deaf.taken.length === 0, 'a source that offers a thing past her lift cap is refused by the hands themselves')
}

console.log(failures === 0 ? 'check-hands: all passed' : `check-hands: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
