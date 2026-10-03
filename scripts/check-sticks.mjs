// Node-side gates for the loose sticks (src/v2/render/sticks.js): the stick's shape, the scatter's determinism and exclusions, and the pick, evict and take-once round trip.
//
//   node scripts/check-sticks.mjs
//
// What can go wrong without throwing: a stick that is not 0.5 m or whose tip is not at -Z (a torch would burn at the wrong end), a scatter that reshuffles when a neighbour is picked, sticks out in the open, inside a trunk, under a lake or in a village, a picked stick that grows back, a peer's pick that leaves a ghost.

import * as THREE from 'three'
import { Sticks, buildStickGeometry, KIND, LENGTH_M, SIDES, SEGMENTS, TIP, CELL_M, NEAR_TRUNK_M } from '../src/v2/render/sticks.js'
import { TILE as TREE_TILE } from '../src/v2/render/trees.js'
import { taken } from '../src/v2/taken.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const scene = new THREE.Scene()
const ground = { heightAt: (x, z) => 0.1 * x }
// isSubmerged as WaterSurfaces answers it: water standing above the ground.
const waterAt = (level) => ({ isSubmerged: (x, z, y) => y < level })
const dry = waterAt(-Infinity)
// Trunks of radius 0.3 on a 6.25 m lattice, west of x = 0 only, so the east half is open ground.
const TRUNK_R = 0.3
const STEP = TREE_TILE / 4
const trees = {
  pureTrunksInto(tx, tz, out) {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const x = (tx + (i + 0.5) / 4) * TREE_TILE, z = (tz + (j + 0.5) / 4) * TREE_TILE
      if (x < 0) out.push(x, z, TRUNK_R)
    }
    return out
  },
}
const bare = { pureTrunksInto: (tx, tz, out) => out }
const make = (over = {}, water = dry) => new Sticks(scene, ground, water, null, { seed: 5, radius: 24, trees, ...over })
// Distance from stick `id`'s centre out past the nearest trunk's bark in the stub lattice.
const barkGap = (s, id) => {
  const x = s.x[id], z = s.z[id]
  let best = Infinity
  for (let gx = Math.floor(x / STEP) - 1; gx <= Math.floor(x / STEP) + 1; gx++) for (let gz = Math.floor(z / STEP) - 1; gz <= Math.floor(z / STEP) + 1; gz++) {
    const tx = (gx + 0.5) * STEP, tz = (gz + 0.5) * STEP
    if (tx < 0) best = Math.min(best, Math.hypot(x - tx, z - tz) - TRUNK_R)
  }
  return best
}

console.log('shape')
{
  const g = buildStickGeometry()
  const pos = g.attributes.position
  const box = g.boundingBox
  check(Math.abs(box.max.z - box.min.z - LENGTH_M) < 0.06, 'a stick is about half a metre long', (box.max.z - box.min.z).toFixed(3))
  check(pos.count === SIDES * (SEGMENTS + 1) + 2, `${SIDES} sides on ${SEGMENTS + 1} rings plus two stubs`, String(pos.count))
  check(TIP.z < 0, 'the tip is at -Z')
  const mid = []
  for (let i = SIDES; i < SIDES * 2; i++) mid.push(pos.getX(i))
  check(Math.max(...mid) - Math.min(...mid) > 0.01, 'a ring is uneven, not a clean circle')
  check(JSON.stringify([...buildStickGeometry().attributes.position.array]) === JSON.stringify([...pos.array]), 'the geometry is deterministic')
}

console.log('scatter')
{
  taken.clear?.()
  const a = make()
  a.place(0, 0)
  const n = a.stats.placed
  check(n > 10, 'sticks lie around the spawn', String(n))
  const b = make()
  b.place(0, 0)
  check(b.stats.placed === n, 'the same seed lays the same sticks')
  const wet = make({}, waterAt(1e6))
  wet.place(0, 0)
  check(wet.stats.placed === 0, 'no stick lies under a lake')
  const ocean = make({}, waterAt(-1e6))
  ocean.place(0, 0)
  check(ocean.stats.placed === n, 'a plane buried under the land does not strip the sticks')
  const village = make({ none: true })
  village.place(0, 0)
  check(village.stats.placed === 0, 'a village lays none')
  const ids = [...a.cells.values()].flatMap((c) => c.ids)
  const gaps = ids.map((id) => barkGap(a, id))
  check(gaps.every((g) => g <= NEAR_TRUNK_M), `every stick lies within ${NEAR_TRUNK_M} m of a trunk's bark`, `widest ${Math.max(...gaps).toFixed(2)} m`)
  check(gaps.every((g) => g >= LENGTH_M / 2), 'no stick lies inside a trunk', `closest ${Math.min(...gaps).toFixed(2)} m`)
  check(ids.every((id) => a.x[id] < NEAR_TRUNK_M + STEP / 2), 'none lies out on the open ground past the last trunk')
  const open = make({ trees: bare })
  open.place(0, 0)
  check(open.stats.placed === 0, 'ground with no trees lays none')
  let threw = false
  try { new Sticks(scene, ground, dry, null, { seed: 5 }) } catch { threw = true }
  check(threw, 'a scatter given no trees refuses to build')
  const far = make()
  far.place(0, 0)
  far.update(400, 0, 0, Infinity)
  check([...far.cells.values()].every((c) => c.cx * CELL_M > 300), 'cells out of reach are dropped')
}

console.log('pick')
{
  const s = make()
  s.place(0, 0)
  const start = s.stats.placed
  let hit = null
  let at = null
  for (const cell of s.cells.values()) if (cell.ids.length) { const id = cell.ids[0]; at = [s.x[id], s.y[id], s.z[id]]; break }
  hit = s.pickAt(...at, 0.5)
  check(hit !== null, 'a stick underfoot is found')
  check(s.pickAt(at[0] + 50, at[1], at[2], 0.5) === null, 'none is found out of reach')
  const rec = s.take(hit)
  check(rec.kind === KIND && rec.stowable && rec.size > 0.3, 'taking yields a stowable stick record')
  check(s.stats.placed === start - 1, 'a taken stick leaves the ground')
  check(taken.has(KIND, at[0], at[2]), 'its spot is recorded')
  const again = make()
  again.place(0, 0)
  check(again.stats.placed === start - 1, 'a picked stick does not grow back in a fresh scatter')
  const peer = make()
  peer.place(0, 0)
  check(peer.evict(KIND, at[0] + 0.01, at[2]) === false, 'an evict for an already-taken spot finds nothing')
  let other = null
  for (const cell of peer.cells.values()) if (cell.ids.length) { const id = cell.ids[0]; other = [peer.x[id], peer.z[id]] }
  const before = peer.stats.placed
  check(peer.evict(KIND, other[0] + 0.01, other[1]) === true && peer.stats.placed === before - 1, 'a peer\'s pick removes the stick here')
  check(Math.abs(s.slot().size - LENGTH_M) < 1e-9 && s.dress(s.slot()).geometry === s.geometry, 'a slot dresses with the shared geometry')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
