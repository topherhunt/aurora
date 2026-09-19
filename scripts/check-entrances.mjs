// Node-side gates for the leafkin village entrances (src/v2/render/entrances.js,
// DESIGN.md §30).
//
//   node scripts/check-entrances.mjs
//
// A mouth is a thing she walks into, so what is gated is the walk: a mouth
// point on dry level ground in front of a face with two metres of wall behind
// it, the hole's quad proud of that stone and inside the arch, the arch upright
// with its passage on the face's normal, every site the same on a second boot
// to the bit, and a site's record kept across the layer losing and regrowing
// it. The world is check-rocks' flat forest: the real biome field over flat
// ground, so the hollow bed grows where the wood is deep and nowhere else.

import * as THREE from 'three'
import { Rocks } from '../src/v2/render/rocks.js'
import {
  Entrances, HOLE, MOUTH_HEIGHT_M, MOUTH_STEP_M, PROBE, RADIUS_M, RUNGS, mouthBankFrom, wallReach,
} from '../src/v2/render/entrances.js'
import { PROP_STEPS, propReach } from '../src/v2/render/gen-props.js'
import { buildTextureArray } from '../src/textures.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const GROUND = 60
const field = {
  scatterAt: (x, z, cell, out) => { out.h = GROUND; out.tan = 0; return out },
  heightAt: () => GROUND,
  snowLineAt: () => 9999,
  bands: { altLo: 0, altSpan: 900 },
}
const water = { levelAt: () => null, isSubmerged: () => false, shoreDistAt: (x, z, reach) => reach }
const layers = { flattenAt: () => 0, shoreAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

/** A world grown about (cx, cz): the rocks, and the entrances over them. */
const boot = (cx, cz, { seed = 7, radius = null } = {}) => {
  const rocks = new Rocks(new THREE.Scene(), field, water, layers, texArray, { seed })
  rocks.place(cx, cz)
  const scene = new THREE.Scene()
  const e = new Entrances(scene, field, water, rocks, { seed, radius, bank: mouthBankFrom(readShippedLadder('cave-mouth')) })
  e.place(cx, cz)
  return { rocks, e, scene }
}

const out = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ox: 0, oz: 0, size: 0 }

// --- the sites --------------------------------------------------------------
//
// The rocks hold the spacing (check-rocks pins 400 m by the hollow bed's
// construction); what is new here is that a hollow the rocks grow is a mouth
// the layer seats, and where it puts it. Walking four boots over a 4 km
// square gathers every hollow the wood grows in it.
console.log('\nthe sites')
const all = new Map()
let blind = 0
for (const [cx, cz] of [[-1000, -1000], [1000, -1000], [-1000, 1000], [1000, 1000]]) {
  const { rocks, e } = boot(cx, cz, { radius: 1400 })
  const hollows = rocks.hollowsInto(cx - 1400, cz - 1400, cx + 1400, cz + 1400, new Float32Array(64 * 5))
  check(e.stats.placed + e.stats.blind === hollows, `every hollow the rocks grew about (${cx}, ${cz}) was probed`,
    `${hollows} hollows, ${e.stats.placed} mouths, ${e.stats.blind} blind, rejected ${JSON.stringify(e.stats.rejected)}`)
  blind += e.stats.blind
  for (const s of e.sites()) all.set(s.key, s)
}
const sites = [...all.values()]
check(sites.length >= 6, 'the square holds a handful of villages', `${sites.length} sites, ${blind} blind`)
check(blind === 0, 'and no hollow was refused a mouth on flat ground', `${blind} blind`)
let closest = Infinity
for (let i = 0; i < sites.length; i++) {
  for (let j = i + 1; j < sites.length; j++) closest = Math.min(closest, Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z))
}
check(closest >= 400, 'no two mouths within 400 m', `closest ${closest.toFixed(0)} m`)

// --- the face ---------------------------------------------------------------
//
// From the mouth point, looking along -n: the stone is MOUTH_STEP_M away, a
// wall for two metres above the eye, and its normal is within PROBE.faceDeg of
// the plane. Then the hole: a ray from the mouth point to the quad's centre
// meets the quad before the stone, and one to each of its corners too.
console.log('\nthe face')
{
  const { rocks, e } = boot(-1000, -1000, { radius: 1400 })
  const rows = e.sites()
  let faced = 0, walled = 0, holed = 0, arched = 0
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const m = new THREE.Matrix4()
  for (const site of rows) {
    const { x, y, z, nx, nz } = site
    check(Math.abs(Math.hypot(nx, nz) - 1) < 1e-5, `site ${site.key}: the normal is a unit vector in the plane`)
    const t = rocks.hollowRayAt(x, y + PROBE.eye, z, -nx, 0, -nz, 4, out)
    const flat = Math.abs(out.ny) <= Math.sin((PROBE.faceDeg * Math.PI) / 180)
    faced += t < wallReach() && flat ? 1 : 0
    walled += rocks.hollowRayAt(x, y + PROBE.eye + PROBE.wall, z, -nx, 0, -nz, wallReach(), out) < Infinity ? 1 : 0
    // The hole's quad, off the layer's own matrix: its centre and corners in
    // the world, each a ray target from the mouth point.
    m.fromArray(e.holeM, site.id * 16)
    m.decompose(p, q, s)
    const across = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const up = new THREE.Vector3(0, 1, 0)
    let ok = 0
    for (const [u, v] of [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const c = p.clone().addScaledVector(across, u * HOLE.width * 0.9).addScaledVector(up, v * HOLE.height * 0.9)
      const d = c.clone().sub(new THREE.Vector3(x, y + 0.5, z))
      const len = d.length()
      d.divideScalar(len)
      const t = rocks.hollowRayAt(x, y + 0.5, z, d.x, d.y, d.z, len + 2, out)
      if (t > len) ok++
    }
    holed += ok === 5 ? 1 : 0
    // The arch stands upright at the site's floor with its X on the normal.
    e.batch.getMatrixAt(site.id, m)
    m.decompose(p, q, s)
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const aligned = Math.abs(ax.x * nx + ax.z * nz - 1) < 1e-4 && ay.y > 0.9999
    const seated = Math.abs(p.y - (GROUND - 0.05)) < 1e-4 && Math.abs(s.y * (MOUTH_HEIGHT_M / e.bank.scale) - MOUTH_HEIGHT_M) < 1e-6
    arched += aligned && seated ? 1 : 0
  }
  check(faced === rows.length, 'every mouth point looks at a face within 20 deg of vertical, within reach', `${faced}/${rows.length}`)
  check(walled === rows.length, 'and at two metres of wall above it', `${walled}/${rows.length}`)
  check(holed === rows.length, 'the hole\'s quad stands proud of the stone at its centre and its corners', `${holed}/${rows.length}`)
  check(arched === rows.length, 'the arch stands upright on the floor, MOUTH_HEIGHT_M tall, its passage on the normal', `${arched}/${rows.length}`)
  const stepped = rows.every((site) => Math.hypot(site.x - site.ax, site.z - site.az) > MOUTH_STEP_M)
  check(stepped, 'the mouth point is outside the arch\'s centre', '')
}

// --- two boots agree ----------------------------------------------------------
console.log('\ntwo boots agree')
{
  const a = boot(0, 0).e.sites().sort((p, q) => (p.key < q.key ? -1 : 1))
  const b = boot(0, 0).e.sites().sort((p, q) => (p.key < q.key ? -1 : 1))
  const same = a.length === b.length && a.every((s, i) => {
    const t = b[i]
    return s.key === t.key && s.x === t.x && s.y === t.y && s.z === t.z && s.nx === t.nx && s.nz === t.nz && s.r === t.r
  })
  check(same && a.length > 0, 'a second boot seats every mouth on the same point and normal to the bit', `${a.length} sites`)
  const other = boot(0, 0, { seed: 11 }).e.sites()
  const keys = new Set(a.map((s) => s.key))
  const moved = other.filter((s) => keys.has(s.key)).some((s) => a.find((t) => t.key === s.key).nx !== s.nx)
  check(moved || other.every((s) => !keys.has(s.key)), 'and another seed rolls another bearing', `${other.length} sites on seed 11`)
}

// --- the record survives eviction -------------------------------------------
//
// The leafkin's cooldown lives on the site's `state`; the layer keeps it in
// `memory` past the tile going, so a village she scared empty stays empty
// when she walks back an hour later.
console.log('\nthe record survives eviction')
{
  const { e } = boot(0, 0, { radius: 600 })
  const first = e.sites()[0]
  check(!!first, 'a site is resident at the origin', `${e.stats.placed} placed`)
  if (first) {
    first.state.fledAt = 1234
    const far = { x: first.x + 3000, z: first.z + 3000 }
    e.rocks.place(far.x, far.z)
    e.update(far.x, GROUND, far.z)
    check(!e.sites().some((s) => s.key === first.key), 'the site goes when the camera leaves', `${e.stats.placed} resident`)
    check(e.stats.used === e.stats.placed, 'and its instance returns to the pool', `${e.stats.used} used`)
    e.rocks.place(0, 0)
    e.update(0, GROUND, 0)
    const back = e.sites().find((s) => s.key === first.key)
    check(!!back && back.state.fledAt === 1234, 'and comes back with its record', back ? `fledAt ${back.state.fledAt}` : 'not back')
    check(!!back && back.id >= 0 && back !== first, 'on a fresh site object', '')
  }
}

// --- the ladder -----------------------------------------------------------------
console.log('\nthe ladder')
{
  const { e } = boot(0, 0, { radius: 600 })
  const site = e.sites()[0]
  const reach = (k) => propReach(MOUTH_HEIGHT_M, k)
  const tiersAt = []
  for (const d of [reach(0) * 0.5, reach(0) * 1.5, reach(1) * 1.5, reach(2) * 1.5]) {
    e.update(site.ax + site.nx * d, site.ay, site.az + site.nz * d)
    tiersAt.push(e.tierAt[site.id])
  }
  check(tiersAt.join(' ') === '0 1 2 3', 'an arch steps down its three tiers and out past the props\' cull', `tiers ${tiersAt.join(' ')} at rungs ${PROP_STEPS.join('/')}`)
  const hidden = tiersAt[3] === RUNGS && !e.batch.getVisibleAt(site.id)
  check(hidden, 'culled, the arch is hidden', '')
  e.update(site.ax + site.nx * reach(0) * 0.5, site.ay, site.az + site.nz * reach(0) * 0.5)
  check(e.batch.getVisibleAt(site.id) && e.tris > 0, 'and back in, drawn', `${e.tris} tris`)
  check(e.stats.cull > 100, 'the props\' cull for a 1.5 m arch is past a hundred metres', `${e.stats.cull.toFixed(0)} m`)
  check(RADIUS_M >= 200, 'a site is resident past the leafkin\'s roam', `${RADIUS_M} m`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall entrances checks passed')
process.exit(failures ? 1 : 0)
