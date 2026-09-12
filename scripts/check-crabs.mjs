// Node-side gates for the crabs (src/v2/render/crabs.js).
//
//   node scripts/check-crabs.mjs
//
// The scatter runs against a synthetic lake: a 30 m bowl of water at y = 12,
// eight metres deep in the middle, with a gentle bank rising away from the
// shore, and a handful of hemispherical boulders -- one on the lake floor, a
// small one beside it, one on the shelf, one on the beach with a cobble next to
// it, one too far up the bank, one far away.
// Everything below is a way a crab can go wrong without anything throwing: a
// crab on the terrain, in the air or inside a stone; a crab on a rock past the
// shore band or on one under a metre; beach crabs as big as the deep ones; a
// crab smaller than the floor or out of proportion to its rock; a crab that walks off its
// rock or never moves; a scatter that is not the same twice; a tile whose
// rocks landed late and never got its crabs; a frame that costs more than a
// scatter is allowed to; a far crab still drawn as the mesh, or a card that does
// not stand on its crab's stone at its crab's tilt, or that is not dithered.
// The shipped GLB is checked for existence and shape too, because the world
// loads it by name.
//
// What this can NOT check: whether they look like crabs, or how the scuttle
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Crabs, SHORE_M, PERCH_MIN, SIZE_M, DEEP_MUL, ROCK_FRACTION, PER_PERCH, SPEED } from '../src/v2/render/crabs.js'
import { PERCH_STRIDE } from '../src/v2/render/rocks.js'
import { CARD_M, CRITTER_GLB } from '../src/v2/render/critters.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic lake --------------------------------------------------------
const LEVEL = 12
const LAKE_R = 30
const DEEP = 8
const BANK_TAN = 0.2
const groundAt = (x, z) => {
  const d = Math.hypot(x, z)
  if (d < LAKE_R) { const r = d / LAKE_R; return LEVEL - DEEP * (1 - r * r) }
  return LEVEL + (d - LAKE_R) * BANK_TAN
}
const height = {
  heightAt: groundAt,
  heightAndSlopeAt(x, z) {
    const d = Math.hypot(x, z)
    return { h: groundAt(x, z), tan: d < LAKE_R ? (2 * DEEP * d) / (LAKE_R * LAKE_R) : BANK_TAN, gx: 0, gz: 0 }
  },
}
const water = {
  lakeLevelAt: (x, z) => (Math.hypot(x, z) < LAKE_R + 15 ? LEVEL : null),
  lakeShoreDistAt(x, z, reach) {
    if (!(reach > 0)) throw new Error('reach')
    const d = Math.hypot(x, z) - LAKE_R
    return d > reach ? reach : d < -reach ? -reach : d
  },
}

// Hemispheres seated at their centre's ground height; a rock's size is its width, 2r. `name` is for the report.
const BOULDERS = [
  { name: 'floor', x: 0, z: 0, r: 2 },
  { name: 'stone', x: 5, z: 5, r: 0.6 },
  { name: 'shelf', x: 20, z: 0, r: 2 },
  { name: 'beach', x: 33, z: 0, r: 1.5 },
  { name: 'cobble', x: 33, z: 4, r: 0.45 },
  { name: 'bank', x: 40, z: 0, r: 2 },
  { name: 'far', x: 70, z: 70, r: 3 },
]
for (const b of BOULDERS) b.y = groundAt(b.x, b.z)
const WANT = new Set(['floor', 'stone', 'shelf', 'beach'])
let live = []
const surfaceOf = (b, x, z) => {
  const d2 = (x - b.x) ** 2 + (z - b.z) ** 2
  return d2 < b.r * b.r ? b.y + Math.sqrt(b.r * b.r - d2) : -Infinity
}
const rocks = {
  calls: 0,
  perchesInto(x0, z0, x1, z1, out) {
    let w = 0
    for (const b of live) {
      if (b.x < x0 || b.x >= x1 || b.z < z0 || b.z >= z1) continue
      const o = w * PERCH_STRIDE
      out[o] = b.x; out[o + 1] = b.y - 0.3; out[o + 2] = b.z; out[o + 3] = b.r * 1.1; out[o + 4] = 2 * b.r
      w++
    }
    return w
  },
  blockTopAt(x, z, minSize, settle) {
    this.calls++
    if (settle !== false) throw new Error('crabs must ask for the unsettled surface')
    let best = -Infinity
    for (const b of live) {
      if (2 * b.r < minSize) continue
      const s = surfaceOf(b, x, z)
      if (s > best) best = s
    }
    return best
  },
}
const stoneUnder = (c) => rocks.blockTopAt(c.x, c.z, PERCH_MIN, false)
const boulderOf = (c) => BOULDERS.find((b) => surfaceOf(b, c.x, c.z) > -Infinity)

// --- the shipped asset ---------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.crab}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.crab} is shipped -- run tools/creatures/ship.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    check(buf.toString('latin1', 0, 4) === 'glTF', 'the crab GLB has a glTF header')
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
    check(json.meshes?.length === 1 && json.meshes[0].primitives.length === 1, 'one mesh, one primitive', `${json.meshes?.length} meshes`)
    check(json.images?.length >= 1 && json.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture !== undefined, 'a base colour texture to draw')
  }
}

// --- a stand-in asset: a unit slab, feet at y = 0 ------------------------------
const box = new THREE.BoxGeometry(0.75, 0.3, 1).translate(0, 0.15, 0)
const asset = {
  pos: box.getAttribute('position').array,
  nrm: box.getAttribute('normal').array,
  uv: box.getAttribute('uv').array,
  idx: Array.from(box.index.array),
  map: null,
}

// --- construction and the shader hook -----------------------------------------
const scene = new THREE.Scene()
const crabs = new Crabs(scene, height, water, { seed: 11, rocks, assets: asset })
check(crabs.loaded && crabs.mesh.visible && Math.abs(crabs.span - 1) < 1e-6, 'asset set: visible, span 1', `span ${crabs.span}`)
{
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>\n' }
  crabs.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec2 aLegs') && shader.vertexShader.includes('legW') && shader.vertexShader.includes('transformed.y +='), 'leg wiggle spliced into begin_vertex')
  check(crabs.mesh.geometry.getAttribute('aLegs').isInstancedBufferAttribute, 'aLegs is per instance')
}

// --- placement -----------------------------------------------------------------
// A perch carries PER_PERCH * (1 + rand * r^2) crabs on average, so any one rock may
// have none; the placement checks pool SEEDS worlds' worth so each boulder is judged
// on its expectation, and every crab in the pool on its own terms.
const alive = (of = crabs) => of.slots.filter((c) => c.perch !== null)
live = BOULDERS
const SEEDS = 16
const pool = []
for (let seed = 1; seed <= SEEDS; seed++) {
  const k = new Crabs(scene, height, water, { seed, rocks, assets: asset })
  k.place(15, 0)
  check(k.overflow === 0 && k.saturated === 0, `seed ${seed}: nothing was dropped for want of room`)
  for (const c of alive(k)) pool.push({ x: c.x, y: c.y, z: c.z, size: c.size, depth: c.depth })
  k.dispose()
}
crabs.place(15, 0)
{
  const all = pool
  check(all.length >= 4 * SEEDS, 'the lake\'s boulders carry crabs', `${all.length} over ${SEEDS} seeds; one seed: ${JSON.stringify(crabs.stats)}`)
  const homes = all.map(boulderOf)
  check(homes.every((b) => b && WANT.has(b.name)), 'every crab is on a lake-floor, shelf or beach boulder', [...new Set(homes.map((b) => b?.name ?? 'none'))].join(', '))
  const bank = BOULDERS.find((b) => b.name === 'bank')
  check(!homes.some((b) => b.name === 'bank'), `the boulder ${bank.x - LAKE_R} m up the bank has none (band is ${SHORE_M} m)`)
  const cobble = BOULDERS.find((b) => b.name === 'cobble')
  check(!homes.some((b) => b.name === 'cobble'), `the ${2 * cobble.r} m cobble on the beach has none (a perch is ${PERCH_MIN} m)`)
  // The stub's hull radius is 1.1 r, and none of these is big enough for PERCH_CAP to bind.
  for (const b of BOULDERS.filter((b) => WANT.has(b.name))) {
    const got = homes.filter((h) => h === b).length / SEEDS
    const want = PER_PERCH * (1 + 0.5 * (1.1 * b.r) ** 2)
    check(got > want * 0.65 && got < want * 1.35, `the ${2 * b.r} m ${b.name} boulder carries about ${want.toFixed(2)} crabs`, `${got.toFixed(2)} a seed`)
  }
  check(all.every((c) => Math.abs(c.y - stoneUnder(c)) < 1e-6), 'every crab sits on the stone\'s own surface', `${all.length} crabs`)
  check(all.every((c) => c.y > groundAt(c.x, c.z)), 'no crab is on or under the terrain')
  const mean = (name) => { const s = all.filter((c) => boulderOf(c).name === name).map((c) => c.size); return s.reduce((a, b) => a + b, 0) / s.length }
  const floor = mean('floor'), shelf = mean('shelf'), beach = mean('beach'), stone = mean('stone')
  check(floor > beach * 1.5 && beach <= SIZE_M[1] && floor <= SIZE_M[1] * DEEP_MUL, 'deep water makes larger crabs', `floor ${floor.toFixed(3)} m, shelf ${shelf.toFixed(3)} m, beach ${beach.toFixed(3)} m`)
  check(all.every((c) => c.size >= SIZE_M[0] - 1e-6), `no crab is under ${SIZE_M[0]} m`, `${Math.min(...all.map((c) => c.size)).toFixed(3)} m`)
  const capOf = (b) => Math.max(SIZE_M[0], ROCK_FRACTION * 2 * b.r)
  check(all.every((c) => c.size <= capOf(boulderOf(c)) + 1e-6), `no crab is over ${ROCK_FRACTION * 100}% of its rock's width, unless that is under the floor`)
  const floorB = BOULDERS.find((b) => b.name === 'floor')
  check(Math.abs(Math.max(...all.filter((c) => boulderOf(c) === floorB).map((c) => c.size)) - capOf(floorB)) < 1e-6, `the ${2 * floorB.r} m floor boulder's biggest crab is exactly its ${ROCK_FRACTION * 100}%`, `${capOf(floorB).toFixed(3)} m at ${DEEP} m of water`)
  check(Math.abs(stone - SIZE_M[0]) < 1e-6 && stone < floor, `the ${2 * BOULDERS[1].r} m floor stone's crabs are all the floor size: its 20% would be smaller`, `stone ${stone.toFixed(3)} m, floor ${floor.toFixed(3)} m`)
  check(all.filter((c) => boulderOf(c).name === 'floor').every((c) => c.y < LEVEL), 'lake-floor crabs are under the water')
  const sizes = all.map((c) => c.size)
  check(Math.max(...sizes) - Math.min(...sizes) > 0.05, 'sizes vary', `${Math.min(...sizes).toFixed(3)}..${Math.max(...sizes).toFixed(3)} m`)
}
// Determinism: the same rocks, the same crabs.
const snapA = alive().map((c) => [c.x, c.z, c.size]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
crabs.place(200, 200)
check(alive().length === 0, 'nothing away from the lake')
crabs.place(15, 0)
const snapB = alive().map((c) => [c.x, c.z, c.size]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
check(JSON.stringify(snapA) === JSON.stringify(snapB), 'placement is a pure function of the rocks', `${snapA.length} crabs`)

// --- the run -------------------------------------------------------------------
const DT = 1 / 72
const SECONDS = 60
const start = new Map(alive().map((c) => [c, { x: c.x, z: c.z }]))
let offStone = 0
let floating = 0
let offPerch = 0
let tilted = 0
let moved = 0
const paces = []
rocks.calls = 0
const t0 = performance.now()
for (let i = 0; i < SECONDS / DT; i++) {
  crabs.update(15, LEVEL + 1.6, 0, DT)
  for (const c of alive()) {
    const top = stoneUnder(c)
    if (top === -Infinity) offStone++
    else if (Math.abs(c.y - top) > 1e-6) floating++
    if (Math.hypot(c.x - c.perch.x, c.z - c.perch.z) > c.perch.r + 1e-6) offPerch++
    if (c.ny < 0.999) tilted++
    if (c.state === 'go' && c.left > 0 && (i % 36) === 0) paces.push(c.speed)
  }
}
const ms = (performance.now() - t0) / (SECONDS / DT)
for (const [c, s] of start) if (Math.hypot(c.x - s.x, c.z - s.z) > 0.05) moved++
check(offStone === 0, 'no crab ever leaves the stone', `${offStone} frames`)
check(floating === 0, 'no crab ever floats above or sinks into it', `${floating} frames`)
check(offPerch === 0, 'no crab leaves its own rock\'s disc', `${offPerch} frames`)
check(moved > alive().length * 0.5, 'crabs crawl about', `${moved} of ${alive().length} moved`)
check(tilted > 0, 'crabs ride the stone\'s slope', `${tilted} tilted frames`)
{
  const slow = paces.filter((p) => p < SPEED[0] * 3).length / paces.length
  const dash = paces.filter((p) => p > SPEED[1] * 0.6).length / paces.length
  check(slow > 0.25 && dash > 0.05 && dash < slow, 'the pace varies spell to spell, mostly a slow crawl with the odd dash', `${(slow * 100).toFixed(0)}% under ${(SPEED[0] * 3).toFixed(2)} spans/s, ${(dash * 100).toFixed(0)}% over ${(SPEED[1] * 0.6).toFixed(2)}, of ${paces.length} samples`)
}
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame, ${(rocks.calls / (SECONDS / DT)).toFixed(1)} surface queries/frame`)
check(crabs.mesh.count === alive().length && crabs.card.count === 0, 'the instance count is the live count, and before the bake all of it is the mesh', `${crabs.mesh.count}`)

// --- the cross card: far crabs leave the mesh for the card, under the same matrix ----
{
  check(crabs.card.parent === crabs.batch && !crabs.card.visible && crabs.card.geometry.index.count === 12, 'the card mesh rides in the batch, hidden until its picture is baked, two quads')
  const shader = { vertexShader: '#include <common>', fragmentShader: '#include <clipping_planes_fragment>\n#include <normal_fragment_begin>' }
  crabs.cardMaterial.onBeforeCompile(shader)
  check(/gl_FragCoord\.x \+ gl_FragCoord\.y, 2\.0 \) < 1\.0 \) discard/.test(shader.fragmentShader) && crabs.cardMaterial.alphaTest === 0.5, 'the card is a cutout drawn on every other pixel of a fixed screen checkerboard')
  check(crabs.cardMaterial.customProgramCacheKey() !== crabs.material.customProgramCacheKey(), 'the card compiles its own program')
  // Pooled over seeds again, so both sides of the line are populated: the shelf is a few metres from her, the floor and the beach well past CARD_M.
  const HEAD = [15, LEVEL + 1.6, 0]
  const dist = (e, i) => Math.hypot(e[i * 16 + 12] - HEAD[0], e[i * 16 + 13] - HEAD[1], e[i * 16 + 14] - HEAD[2])
  let meshN = 0, cardN = 0, liveN = 0, matched = 0
  const near = [], far = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = new Crabs(scene, height, water, { seed, rocks, assets: asset })
    k.setCard(null)
    k.place(15, 0)
    k.update(...HEAD, DT)
    const e = k.mesh.instanceMatrix.array, ce = k.card.instanceMatrix.array
    for (let i = 0; i < k.mesh.count; i++) near.push(dist(e, i))
    for (let i = 0; i < k.card.count; i++) {
      far.push(dist(ce, i))
      // The card stands where its crab stands, on the crab's own normal.
      const c = alive(k).find((c) => Math.abs(c.x - ce[i * 16 + 12]) < 1e-4 && Math.abs(c.z - ce[i * 16 + 14]) < 1e-4)
      if (!c) continue
      const up = new THREE.Vector3(ce[i * 16 + 4], ce[i * 16 + 5], ce[i * 16 + 6]).normalize()
      if (Math.abs(up.x - c.nx) < 1e-5 && Math.abs(up.y - c.ny) < 1e-5 && Math.abs(up.z - c.nz) < 1e-5 && Math.abs(up.length() - 1) < 1e-5) matched++
    }
    meshN += k.mesh.count; cardN += k.card.count; liveN += alive(k).length
    k.dispose()
  }
  check(meshN + cardN === liveN && meshN > 0 && cardN > 0, 'the mesh and the card together hold every crab', `${meshN} mesh, ${cardN} card, ${liveN} alive over ${SEEDS} seeds`)
  check(near.every((d) => d <= CARD_M) && far.every((d) => d > CARD_M), `the mesh holds the crabs within ${CARD_M} m of her head and the card the rest`, `mesh to ${Math.max(...near).toFixed(2)} m, card from ${Math.min(...far).toFixed(2)} m`)
  check(matched === cardN, 'each card stands where its crab stands, tilted to its stone', `${matched} of ${cardN}`)
}

// --- rocks that land late ------------------------------------------------------
live = []
crabs.place(15, 0)
check(alive().length === 0, 'no rocks, no crabs')
live = BOULDERS
for (let i = 0; i < 400; i++) crabs.update(15, LEVEL + 1.6, 0, DT)
check(alive().length === snapA.length, 'a tile whose rocks landed after the scan gets its crabs on the rescan', `${alive().length} of ${snapA.length}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
