// Node-side gates for her hands (src/v2/hands.js) and the taken registry
// (src/v2/taken.js): the grab, the hold, the drop and its short simulation, the
// backpack zone and its buzz, the stow. Run against a stub source so every
// branch is reached without a bed; the beds' own take/release are gated in
// their own scripts.
//
//   node scripts/check-hands.mjs
//
// What can go wrong without throwing: a held thing drawn somewhere other than
// the hand; a drop that never lands, or lands and never stops; a buzz with an
// empty hand, or none as a full one crosses the shoulder; a stow that loses the
// thing when the backpack is full; a pool that keeps growing; a bed that
// regrows what she took.

import * as THREE from 'three'
import { Hands, REACH_M, GRAB_MAX_M, STOW_MAX_M, LOOSE_MAX, ROLL_MAX_S, FLAP_S, FLAP_FADE_S, ZONE, ZONE_PULSE } from '../src/v2/hands.js'
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
  constructor(things) { this.things = things; this.taken = []; this.releases = []; this.takeBack = null }
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
    return { kind: t.kind, name: t.kind, size: t.size, geometry: geo, material, attrs: { aSwim: [1, 2, 3, 4] }, color: [0.5, 0.6, 0.7], scale: [t.size, t.size, t.size], stowable: t.size < stowMax }
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
  let room = 8
  const hands = new Hands(scene, { walk, water, haptic: (key, i, ms) => pulses.push({ key, i, ms }), stow: (rec) => { if (pack.length >= room) return false; pack.push(rec); return true }, rand: mulberry32(3) })
  const src = new Source([thing('mushroom', 0, 0, 0, 0.2), thing('fish', 2, 0, 0, 0.6), thing('crab', 4, 0, 0, 1.5), thing('crab', 6, 0, 0, 2.5)])
  hands.addSource(src)
  const node = new THREE.Group()
  scene.add(node)
  hands.addHand('right', node)
  const head = { x: 0, y: 1.6, z: 0, yaw: 0 }
  const at = (x, y, z) => { node.position.set(x, y, z); node.updateMatrixWorld(true) }
  const run = (s, dt = 1 / 60) => { for (let t = 0; t < s; t += dt) hands.update(dt, head) }
  return { scene, hands, src, node, head, at, run, pulses, pack, setRoom: (n) => { room = n } }
}

// --- the constructor refuses a missing world ---------------------------------
{
  let threw = 0
  for (const bad of [{ water, haptic() {}, stow() {} }, { walk, haptic() {}, stow() {} }, { walk, water, stow() {} }, { walk, water, haptic() {} }]) {
    try { new Hands(new THREE.Scene(), bad) } catch { threw++ }
  }
  check(threw === 4, 'the constructor throws without the walk surface, the water, the buzz or the backpack', `${threw} of 4`)
  const h = new Hands(new THREE.Scene(), { walk, water, haptic() {}, stow() {} })
  let bad = 0
  try { h.addSource({}) } catch { bad++ }
  try { h.addHand('x', {}) } catch { bad++ }
  try { h.press('nowhere', { x: 0, y: 0, z: 0, yaw: 0 }) } catch { bad++ }
  check(bad === 3, 'a source without pickAt/take, a hand without a node and an unknown hand throw', `${bad} of 3`)
}

// --- the grab ------------------------------------------------------------------
{
  const w = build()
  w.at(0, 0.5, 0)
  check(w.hands.press('right', w.head) === null && w.src.taken.length === 0, 'a press with nothing in reach takes nothing', `hand 0.4 m over a 0.2 m cap, reach ${REACH_M}`)
  w.at(0, 0.3, 0)
  check(w.hands.press('right', w.head) === 'pick' && w.src.taken.length === 1 && w.src.taken[0].kind === 'mushroom', 'within reach the nearest thing is taken')
  check(w.hands.holding('right')?.kind === 'mushroom' && w.hands.stats.held === 1, 'and the hand holds its record')
  check(w.hands.press('right', w.head) === 'drop' && w.hands.holding('right') === null, 'a second press lets it go')
  // The size caps: a 1.5 m crab is lifted and not stowable, a 2.5 m one is never offered.
  w.at(4, 0.7, 0)
  check(w.hands.press('right', w.head) === 'pick' && w.hands.holding('right').size === 1.5 && w.hands.holding('right').stowable === false, `a ${1.5} m crab is lifted but does not stow`, `GRAB_MAX ${GRAB_MAX_M} STOW_MAX ${STOW_MAX_M}`)
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
  check(pool && pool.mesh.count === 1 && pool.mesh.parent === w.hands.batch, 'one pool for the geometry, one instance drawn')
  const m = new THREE.Matrix4().fromArray(pool.mesh.instanceMatrix.array, 0)
  const p = new THREE.Vector3().setFromMatrixPosition(m)
  // The centre of the box is HOLD_OFFSET off the hand; the box's origin is its centre less (0, 0.1, 0) scaled.
  check(Math.abs(p.x - 3) < 1e-6 && Math.abs(p.y - (1.4 - 0.03 - 0.1 * 0.2)) < 1e-6 && Math.abs(p.z - (-2 - 0.06)) < 1e-6, 'the held thing sits a little under and ahead of the hand', `${p.x.toFixed(3)} ${p.y.toFixed(3)} ${p.z.toFixed(3)}`)
  const swim = pool.geo.getAttribute('aSwim')
  const fade = pool.geo.getAttribute('aPropFade')
  check(swim.isInstancedBufferAttribute && swim !== geo.getAttribute('aSwim') && swim.array[0] === 1 && swim.array[3] === 4, "the record's instanced attributes ride the pool's own copy", Array.from(swim.array.slice(0, 4)).join(','))
  check(fade.array[0] === 1 && pool.geo.getAttribute('position') === geo.getAttribute('position') && pool.geo.index === geo.index, 'aPropFade defaults to 1; the vertex buffers are shared')
  const c = pool.mesh.instanceColor.array
  check(Math.abs(c[0] - 0.5) < 1e-6 && Math.abs(c[2] - 0.7) < 1e-6, 'the tint is the record colour')
  const s = new THREE.Vector3().setFromMatrixScale(m)
  check(Math.abs(s.x - 0.2) < 1e-6, 'and the scale the record scale')
}

// --- the drop: the source first, then the fall, the roll, the stop --------------
{
  const w = build()
  w.at(0, 0.3, 0)
  w.hands.press('right', w.head)
  w.at(10, 1.5, 0)
  w.hands.update(1 / 60, w.head)
  w.hands.press('right', w.head)
  check(w.src.releases.length === 1 && Math.abs(w.src.releases[0].x - 10) < 1e-6 && w.src.releases[0].head.yaw === 0, 'the source is offered the thing at the hand first')
  check(w.hands.loose.length === 1 && w.hands.loose[0].state === 'fall', 'refused, it is loose and falling')
  const item = w.hands.loose[0]
  const y0 = item.y
  w.run(0.25)
  check(item.y < y0 - 0.2 && item.state === 'fall', 'it falls under gravity', `${(y0 - item.y).toFixed(3)} m in 0.25 s`)
  // 4.5 m to the ground: under a second.
  w.run(1)
  check(item.state === 'roll' && Math.abs(item.y - (groundAt(item.x) + item.r)) < 1e-6, 'it lands on the ground and rolls', `state ${item.state}`)
  check(w.src.releases.length === 2 && Math.abs(w.src.releases[1].y - groundAt(10)) < 1e-6, 'the source was offered it again at the ground')
  const x1 = item.x, z1 = item.z
  w.run(0.5)
  check(item.x > x1 + 0.05 && item.z === z1, 'it rolls downhill, +x on this slope', `${(item.x - x1).toFixed(3)} m in 0.5 s`)
  const q0 = item.q.clone()
  w.run(0.2)
  check(item.q.angleTo(q0) > 0.1, 'and turns as it rolls', `${item.q.angleTo(q0).toFixed(2)} rad in 0.2 s`)
  w.run(ROLL_MAX_S)
  check(item.state === 'still', `it is still within ROLL_MAX_S ${ROLL_MAX_S} s`)
  const xs = item.x
  w.run(2)
  check(item.x === xs && w.hands.loose.length === 1 && w.hands.pools.get(geo).mesh.count === 1, 'and stays where it stopped, still drawn')
  // Flat ground: the roll stops early.
  const f = build()
  f.at(0, 0.3, 0)
  f.hands.press('right', f.head)
  f.at(-5, 1, 0)
  f.hands.update(1 / 60, f.head)
  f.hands.press('right', f.head)
  f.run(1.5)
  check(f.hands.loose[0].state === 'still' && Math.abs(f.hands.loose[0].x + 5) < 1e-6, 'on the flat it lands and does not roll', `state ${f.hands.loose[0].state} x ${f.hands.loose[0].x.toFixed(3)}`)
}

// --- a creature the source takes back leaves the hands ----------------------------
{
  const w = build()
  w.src.takeBack = (rec) => rec.kind === 'crab'
  w.at(4, 0.7, 0)
  w.hands.press('right', w.head)
  w.hands.press('right', w.head)
  check(w.hands.loose.length === 0 && w.hands.pools.get(geo).items.length === 0, 'a crab let go of is the layer\'s again, not loose here')
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
  w.hands.press('right', w.head)
  check(w.hands.loose.length === 1 && w.src.releases.length === 1, 'over the lake the fish is refused in the air and falls')
  w.run(1)
  check(w.hands.loose.length === 0 && w.src.releases.length === 2 && w.src.releases[1].y <= LEVEL && w.src.releases[1].y > LEVEL - 0.3, 'and taken back as it meets the surface', `offered at y ${w.src.releases[1]?.y.toFixed(3)} level ${LEVEL}`)
  // Beached.
  const b = build()
  b.at(2, 0.4, 0)
  b.hands.press('right', b.head)
  b.at(-3, 1.2, 0)
  b.hands.update(1 / 60, b.head)
  b.hands.press('right', b.head)
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
  check(w.pulses.length === 6, 'a crab too big to stow does not buzz in the zone', `${w.pulses.length}`)
  check(w.hands.press('right', w.head) === 'drop' && w.pack.length === 2 && w.hands.loose.length === 1, 'and the trigger there drops it')
}

// --- the loose cap ----------------------------------------------------------------
{
  const w = build()
  w.src.things = []
  for (let i = 0; i < LOOSE_MAX + 5; i++) w.src.things.push(thing('mushroom', -10 - i, 0, 0, 0.2))
  for (let i = 0; i < LOOSE_MAX + 5; i++) {
    w.at(-10 - i, 0.3, 0)
    w.hands.press('right', w.head)
    w.hands.press('right', w.head)
  }
  w.hands.update(1 / 60, w.head)
  const pool = w.hands.pools.get(geo)
  check(w.hands.loose.length === LOOSE_MAX && pool.items.length === LOOSE_MAX && pool.mesh.count === LOOSE_MAX, `at most LOOSE_MAX ${LOOSE_MAX} loose things`, `${w.hands.loose.length}`)
  check(Math.abs(w.hands.loose[0].x + 15) < 1e-6, 'the oldest were forgotten first', `oldest at x ${w.hands.loose[0].x}`)
  check(w.hands.stats.taken === LOOSE_MAX + 5 && w.hands.stats.dropped === LOOSE_MAX + 5, 'the counts kept every take and drop')
}

// --- a record with a bad shape throws --------------------------------------------
{
  const w = build()
  w.src.take = () => ({ kind: 'thing', name: 'thing', size: 0.2, geometry: geo, material, attrs: { aSwim: [1, 2] }, color: null, scale: [1, 1, 1], stowable: true })
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

console.log(failures === 0 ? 'check-hands: all passed' : `check-hands: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
