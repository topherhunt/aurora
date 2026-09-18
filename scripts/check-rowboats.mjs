// Node-side gates for the rowboat scatter (src/v2/render/rowboats.js): the
// viking rowboat shipped in public/gen-props/, afloat in the shallows of the
// lakes at about one every 300 m of shoreline.
//
//   node scripts/check-rowboats.mjs
//
// What can go wrong without throwing: a hull turned onto the wrong axis, so
// the boat is headed and carded across its beam; a boat seated on the ground
// or with its keel in it; one floating out in open water or up on the beach;
// a rate off by the strip's width; a lattice; a placement that moves between
// two visits; and a world with no lake that still finds somewhere to moor.

import * as THREE from 'three'
import {
  DRAFT, KEEL_CLEAR, LENGTH, ROWBOATS_PER_M, RUNGS, SHORE_M, Rowboats, hullYaw, rowboatCull, rowboatsBankFrom,
} from '../src/v2/render/rowboats.js'
import { PROP_STEPS, propReach } from '../src/v2/render/gen-props.js'
import { LOD_DEG, LOD_HYSTERESIS, distAt } from '../src/v2/render/critters.js'
import { GEN_PROPS_DIR, readShippedAsset } from './lib/gen-prop-node.mjs'
import path from 'node:path'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

/** The shipped bank, fresh: the scatter takes its geometry by reference and disposes it. */
const shippedBank = () => rowboatsBankFrom(readShippedAsset(path.join(GEN_PROPS_DIR, 'rowboat-viking.glb')))

/**
 * A straight coast: the ground falls from the waterline at x = 0 into a lake
 * plane at `level` on a bank of slope `tan`, and the plane runs under the whole
 * world the way the ocean's does, so the shore distance is the waterline term
 * alone: signed metres along the bank, dry side positive.
 */
const coast = (level, tan) => ({
  field: {
    heightAt: (x) => level - x * tan,
    heightAndSlopeAt: (x) => ({ h: level - x * tan, tan }),
  },
  water: {
    levelAt: () => level,
    lakeLevelAt: () => level,
    lakeShoreDistAt: (x, z, reach, g, t) => {
      const d = (g - level) / Math.max(t, 0.01)
      return d < -reach ? -reach : d > reach ? reach : d
    },
  },
})
const DRY = {
  field: { heightAt: () => 40, heightAndSlopeAt: () => ({ h: 40, tan: 0 }) },
  water: { levelAt: () => null, lakeLevelAt: () => null, lakeShoreDistAt: (x, z, reach) => reach },
}
const place = (world, { seed = 5, radius = null } = {}) => {
  const r = new Rowboats(new THREE.Scene(), world.field, world.water, { seed, radius, bank: shippedBank() })
  r.place(0, 0)
  return r
}
const eachBoat = (r, fn) => {
  for (const tile of r.tiles.values()) for (let k = 0; k < tile.n; k++) fn(tile.ids[k])
}

// --- the bank ---------------------------------------------------------------
{
  console.log('\nthe shipped pick is turned onto its keel and carded along it')
  const raw = readShippedAsset(path.join(GEN_PROPS_DIR, 'rowboat-viking.glb'))
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(raw.pos), 3))
  geo.computeBoundingBox()
  const rawB = geo.boundingBox
  const yaw = hullYaw(geo)
  check(Number.isFinite(yaw), 'hullYaw finds the keel\'s heading', `${(yaw * 180 / Math.PI).toFixed(1)} deg, off a pick ${(rawB.max.x - rawB.min.x).toFixed(2)} x ${(rawB.max.z - rawB.min.z).toFixed(2)} in its own frame`)
  const bank = shippedBank()
  const b = bank.bounds
  check(b.long > b.width * 1.15 && b.long > b.height,
    'and turned by it the hull runs along Z, longer than it is wide', `${b.long.toFixed(2)} long, ${b.width.toFixed(2)} wide (oars out), ${b.height.toFixed(2)} high`)
  // The keel alone, without the oars: the bottom fifth of the mesh should be a long thin thing along Z.
  const pos = bank.tiers[0].geometries[0].attributes.position.array
  let kx = 0
  let kz = 0
  const cap = b.height * 0.2
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] > cap) continue
    kx = Math.max(kx, Math.abs(pos[i]))
    kz = Math.max(kz, Math.abs(pos[i + 2]))
  }
  check(kz > kx * 2, 'the keel itself is at least twice as long along Z as it is across X', `keel band ${(2 * kx).toFixed(2)} across, ${(2 * kz).toFixed(2)} along`)
  check(bank.tiers.length === 2 && RUNGS === 2, 'two tiers, the pick and its card, one rung each', `${bank.tiers.length} tiers, ${RUNGS} rungs`)
  const card = bank.tiers[1].geometries[0]
  card.computeBoundingBox()
  const cb = card.boundingBox
  const quads = card.index.count / 6
  check(quads === 2 && cb.max.z - cb.min.z >= b.long - 1e-3 && cb.max.y - cb.min.y >= b.height - 1e-3 && cb.max.x - cb.min.x >= b.height - 1e-3,
    'the card is the boat\'s length crossed about its axis, upright and flat, covering the pick', `${quads} quads, ${(cb.max.z - cb.min.z).toFixed(2)} long`)
  check(Math.abs(propReach(1, 1) - distAt(1, LOD_DEG) * PROP_STEPS[1]) < 1e-9 && rowboatCull(1) === propReach(1, PROP_STEPS.length - 1),
    'the mesh holds to the props\' second rung and the card to their card reach',
    `per metre of length: mesh to ${propReach(1, 1).toFixed(1)} m, culled at ${rowboatCull(1).toFixed(1)} m; a ${LENGTH[1]} m boat is gone past ${rowboatCull(LENGTH[1]).toFixed(0)} m`)
  for (const t of bank.tiers) for (const g of t.geometries) g.dispose()
}

// --- afloat by the shore ----------------------------------------------------
//
// On a 1:5 bank and on a cliff: every boat level at the plane with its keel a
// draft under it, water under the keel at bow, stern and midships, in the
// strip out to SHORE_M and never up the beach.
{
  console.log('\nevery boat floats in the shallows off the line')
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const LEVEL = 40
  for (const [name, tan] of [['a 1:5 beach', 0.2], ['a steep bank', 1.0]]) {
    const world = coast(LEVEL, tan)
    const r = place(world, { seed: 11, radius: 1200 })
    const bad = []
    let n = 0
    let nearest = Infinity
    let farthest = 0
    eachBoat(r, (id) => {
      n++
      r.batch.getMatrixAt(id, m)
      m.decompose(p, q, s)
      const length = r.long * s.x
      const draft = DRAFT * length
      if (!(length >= LENGTH[0] - 1e-3 && length <= LENGTH[1] + 1e-3)) bad.push(`${length.toFixed(2)} m long`)
      if (Math.abs(p.y - (LEVEL - draft)) > 1e-3) bad.push(`keel at ${p.y.toFixed(2)} against a plane at ${LEVEL}`)
      if (Math.abs(r.instSize[id] - length) > 1e-3) bad.push('instSize is not its length')
      // Bow, stern and midships along its own Z under the placed matrix: each over water at least KEEL_CLEAR deep under the keel.
      for (const z of [-r.long / 2, 0, r.long / 2]) {
        const v = new THREE.Vector3(0, 0, z).applyMatrix4(m)
        const under = v.y - world.field.heightAt(v.x, v.z)
        if (under < KEEL_CLEAR - 1e-3) bad.push(`${under.toFixed(2)} m under the keel at z ${z.toFixed(1)}`)
      }
      // Its origin is in the water, within SHORE_M of the line measured along the bank.
      const shore = -p.x * tan / Math.max(tan, 0.01)
      if (!(shore < 0 && shore > -SHORE_M)) bad.push(`${shore.toFixed(1)} m from the line`)
      nearest = Math.min(nearest, -shore)
      farthest = Math.max(farthest, -shore)
    })
    check(n >= 3, `${name}: placed boats to measure`, `${n} over ${r.tiles.size} tiles, rejected ${JSON.stringify(r.rejected)}`)
    check(bad.length === 0, `${name}: every boat is level at the plane, a draft down, keel clear of the bottom, within ${SHORE_M} m of the line`,
      bad.length === 0 ? `${nearest.toFixed(1)}-${farthest.toFixed(1)} m out` : bad.slice(0, 4).join('; '))
    if (tan === 0.2) {
      // The depth floor: a 1:5 beach has (draft + clearance) of water only from
      // (draft + clearance) / 0.2 out, so no boat sits nearer than that.
      const floor = (DRAFT * LENGTH[0] + KEEL_CLEAR) / tan
      check(nearest >= floor - 1e-3, 'and on the beach the depth floor pushes them out', `nearest ${nearest.toFixed(1)} m against a floor of ${floor.toFixed(1)}`)
    }
    r.dispose()
  }
  const dry = place(DRY, { seed: 11, radius: 600 })
  check(dry.placed === 0 && dry.rejected.dry > 0, 'a world with no lake moors nothing', `${dry.placed} placed, ${dry.rejected.dry} rejected dry`)
  dry.dispose()
}

// --- the rate ---------------------------------------------------------------
//
// A steep bank takes no depth thinning, so the count along a straight coast is
// the rate times the shore inside the disc, averaged over seeds against the
// Poisson noise of a dozen boats a world.
{
  console.log('\nabout one boat every 300 m of shoreline')
  const R = 1500
  const world = coast(40, 1.0)
  const SEEDS = 12
  let total = 0
  const fracs = new Set()
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = place(world, { seed, radius: R })
    total += r.placed
    eachBoat(r, (id) => fracs.add(((r.instX[id] / 40) % 1).toFixed(2)))
    r.dispose()
  }
  const shore = 2 * R
  const expect = shore * ROWBOATS_PER_M * SEEDS
  const per = total / (shore * SEEDS)
  check(total > expect * 0.7 && total < expect * 1.3, `one every ${(1 / per).toFixed(0)} m against ${(1 / ROWBOATS_PER_M).toFixed(0)} asked`,
    `${total} boats over ${SEEDS} seeds of ${shore} m of coast, expected ${expect.toFixed(0)}`)
  check(fracs.size > 6, 'off the lattice: not one position inside its tile', `${fracs.size} distinct offsets`)
}

// --- the ladder and determinism ---------------------------------------------
{
  console.log('\nit steps to its card at its own apparent size, and is the same world every time')
  const world = coast(40, 1.0)
  const a = place(world, { seed: 3, radius: 1200 })
  const keyOf = (r) => {
    const keys = []
    eachBoat(r, (id) => keys.push(`${r.instX[id].toFixed(3)},${r.instY[id].toFixed(3)},${r.instZ[id].toFixed(3)}:${r.instSize[id].toFixed(3)}`))
    return keys.sort().join('|')
  }
  const b = place(world, { seed: 3, radius: 1200 })
  check(a.placed > 0 && keyOf(a) === keyOf(b), 'the same seed moors the same boats', `${a.placed} boats`)
  const c = place(world, { seed: 4, radius: 1200 })
  check(keyOf(a) !== keyOf(c), 'and another seed moors others')

  let cullWrong = 0
  eachBoat(a, (id) => { if (Math.abs(a.rim.gone[id] - Math.min(a.radius, rowboatCull(a.instSize[id]))) > 1e-3) cullWrong++ })
  check(cullWrong === 0, 'every boat is culled at its own length\'s range')

  const wrong = []
  let seen = 0
  const EYE = 41.6
  for (const [cx, cz] of [[10, 0], [-30, 200], [5, -400], [60, 300]]) {
    a.update(cx, EYE, cz)
    a.update(cx, EYE, cz)
    eachBoat(a, (id) => {
      if (a.rim.isHidden(id)) return
      const d = Math.hypot(a.instX[id] - cx, a.instY[id] - EYE, a.instZ[id] - cz)
      seen++
      const want = d / (1 - LOD_HYSTERESIS) <= propReach(a.instSize[id], 1) ? 0 : 1
      if (a.tierAt[id] > want) wrong.push(`${a.instSize[id].toFixed(1)} m at ${d.toFixed(1)} m on T${a.tierAt[id]}`)
    })
  }
  check(seen >= 4, 'walked enough moored boats to measure the ladder', `${seen} instance-frames`)
  check(wrong.length === 0, 'no boat is a card while its mesh is still due', wrong.length === 0 ? `mesh to ${propReach(LENGTH[1], 1).toFixed(0)} m on a ${LENGTH[1]} m boat` : wrong.slice(0, 3).join('; '))
  check(a.tris > 0, 'and the frame counts the triangles it draws', `${a.tris}`)

  const before = keyOf(a)
  a.update(9000, 1.6, 9000)
  check(a.stats.used === a.placed && a.placed <= a.maxInstances, 'walking away returns the evicted boats to the pool', `${a.placed} resident, ${a.stats.used} used of ${a.maxInstances}`)
  a.update(0, 1.6, 0)
  check(keyOf(a) === before, 'and walking back finds them where they were')
  a.dispose(); b.dispose(); c.dispose()
}

console.log(failures ? `\n${failures} rowboat check(s) FAILED` : '\nall rowboat checks passed')
process.exit(failures ? 1 : 0)
