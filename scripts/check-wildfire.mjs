// Node-side gates for the flames a spark leaves (src/v2/render/wildfire.js): lighting, dimming, the big-and-charred third flame, the spread, and a peer's copy.
//
//   node scripts/check-wildfire.mjs
//
// What can go wrong without throwing: a spark in open air that lights nothing versus one on a tree that does not; a flame that never dies; a third flame that does not char the tree, or chars it again on the fourth; flames that spread from a peer's copy and double on every machine; a torch that burns past the slot cap.

import { Wildfire, LIFE_S, BIG_LIFE_S, BIG_GROW, FADE_S, SPREAD_STEP_S, levelAt } from '../src/v2/render/wildfire.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const scene = { add() {} }
const stub = () => {
  const placed = []
  return { placed, group: null, mesh: { count: 0 }, place: (i, x, y, z, o) => { placed[i] = { x, y, z, ...o } }, update() {}, dispose() {} }
}
let charred
const tree = (x, z, extra = {}) => ({ key: `tree:${x},${z}`, kind: 'tree', x, y: 0, z, radius: 0.3, height: 6, char: () => { charred.push(`tree:${x},${z}`) }, ...extra })
const world = (objs) => (x, y, z, r) => objs.filter((o) => Math.hypot(o.x - x, o.z - z) < r + o.radius + 0.01)
const make = (objs, rng = () => 0.99) => { charred = []; const flames = stub(); return { w: new Wildfire(scene, world(objs), { rng, flames }), flames } }

console.log('lighting')
{
  const { w } = make([tree(0, 0)])
  check(w.spark(5, 1, 5, 0) === null && w.count === 0, 'a spark in open air lights nothing')
  check(w.spark(0.35, 1, 0, 0) !== null && w.count === 1, 'a spark at a trunk lights a flame')
  w.spark(0.35, 1.2, 0, 0)
  check(w.count === 2 && charred.length === 0, 'the same tree lit twice burns two flames, uncharred')
}

console.log('dimming')
{
  const { w, flames } = make([tree(0, 0)], () => 0.5)
  w.spark(0.35, 1, 0, 0)
  const die = w.list[0].die
  check(die >= LIFE_S[0] && die <= LIFE_S[1], 'a flame lasts five to ten seconds', die.toFixed(2))
  w.update(0.016, 1, [])
  const risen = flames.placed[0].height
  w.update(0.016, die - FADE_S / 2, [])
  check(flames.placed[0].height < risen && flames.placed[0].height > 0, 'a dying flame has shrunk but burns')
  w.update(0.016, die + 0.1, [])
  check(w.count === 0 && flames.mesh.count === 0, 'the flame is gone after its life and the draw count follows')
  check(levelAt({ born: 0, die: 10 }, 0) === 0 && levelAt({ born: 0, die: 10 }, 5) === 1, 'a flame rises in from nothing')
}

console.log('the third flame')
{
  const { w, flames } = make([tree(0, 0)], () => 0.5)
  w.spark(0.35, 1, 0, 0); w.spark(0.35, 1.3, 0, 0)
  const small = (w.update(0.016, 1, []), flames.placed[0].height)
  w.spark(0.35, 1.6, 0, 1)
  check(charred.length === 1, 'three flames char the tree')
  check(w.list.every((f) => f.big && f.die >= 1 + BIG_LIFE_S - 1e-9), 'all three turn big and last twenty seconds from then')
  w.update(0.016, 3, [])
  check(flames.placed[0].height > small * (BIG_GROW - 0.2), 'a big flame is drawn bigger', `${small.toFixed(3)} -> ${flames.placed[0].height.toFixed(3)}`)
  w.spark(0.35, 2, 0, 3)
  check(charred.length === 1, 'a fourth flame does not char it again')
  w.update(0.016, 3 + BIG_LIFE_S + 1, [])
  check(w.count === 0, 'the big flames dim out after twenty seconds')
}

console.log('spread')
{
  const a = tree(0, 0), b = tree(0.8, 0), far = tree(6, 0)
  let roll = 0
  const { w } = make([a, b, far], () => (roll === 0 ? 0.0 : 0.5))
  w.spark(0.35, 1, 0, 0)
  roll = 1
  w.update(SPREAD_STEP_S, 1, [])
  check(w.count === 1, 'no chance roll, no spread')
  roll = 0
  const made = []
  w.onLight = (f) => made.push(f)
  w.update(SPREAD_STEP_S, 2, [])
  check(w.count >= 2 && made.length >= 1, 'a low roll lights a second flame', String(w.count))
  check(w.list.every((f) => f.key !== far.key), 'flames never jump to an object out of range')
  check(made.every((f) => f.local), 'spread flames are reported for the net')
}

console.log('a peer\'s flame')
{
  const { w } = make([tree(0, 0)], () => 0.0)
  const f = w.remote(0.35, 1, 0, 6, 0)
  check(f && f.key === 'tree:0,0' && !f.local, 'a peer\'s flame finds its tree and is not local')
  let lit = 0
  w.onLight = () => lit++
  w.update(SPREAD_STEP_S * 3, 1, [])
  check(w.count === 1 && lit === 0, 'a peer\'s flame never spreads here')
}

console.log('torches')
{
  const { w, flames } = make([])
  w.update(0.016, 0, [{ x: 1, y: 2, z: 3, phase: 0 }, { x: 4, y: 5, z: 6, phase: 1 }])
  check(flames.mesh.count === 2 && flames.placed[1].x === 4, 'a torch tip is drawn as a flame')
  let threw = false
  try { w.update(0.016, 0, Array.from({ length: 9 }, () => ({ x: 0, y: 0, z: 0, phase: 0 }))) } catch { threw = true }
  check(threw, 'more torches than slots is refused, not dropped')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
