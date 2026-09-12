// Node-side gates for the crabs (src/v2/render/crabs.js).
//
//   node scripts/check-crabs.mjs
//
// The scatter runs against a synthetic lake: a 30 m bowl of water at y = 12,
// eight metres deep in the middle, with a gentle bank rising away from the
// shore, and a handful of hemispherical boulders -- one on the lake floor, one
// on the shelf, one on the beach, one too far up the bank, one far away.
// Everything below is a way a crab can go wrong without anything throwing: a
// crab on the terrain, in the air or inside a stone; a crab on a rock past the
// shore band; beach crabs as big as the deep ones; a crab that walks off its
// rock or never moves; a scatter that is not the same twice; a tile whose
// rocks landed late and never got its crabs; a frame that costs more than a
// scatter is allowed to. The shipped GLB is checked for existence and shape
// too, because the world loads it by name.
//
// What this can NOT check: whether they look like crabs, or how the scuttle
// reads. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Crabs, SHORE_M, PERCH_MIN, SIZE_M, DEEP_MUL } from '../src/v2/render/crabs.js'
import { CRITTER_GLB } from '../src/v2/render/critters.js'

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

// Hemispheres seated at their centre's ground height. `name` is for the report.
const BOULDERS = [
  { name: 'floor', x: 0, z: 0, r: 2 },
  { name: 'shelf', x: 20, z: 0, r: 2 },
  { name: 'beach', x: 33, z: 0, r: 1.5 },
  { name: 'bank', x: 40, z: 0, r: 2 },
  { name: 'far', x: 70, z: 70, r: 3 },
]
for (const b of BOULDERS) b.y = groundAt(b.x, b.z)
const WANT = new Set(['floor', 'shelf', 'beach'])
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
      out[w * 4] = b.x; out[w * 4 + 1] = b.y - 0.3; out[w * 4 + 2] = b.z; out[w * 4 + 3] = b.r * 1.1
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
const alive = () => crabs.slots.filter((c) => c.perch !== null)
live = BOULDERS
crabs.place(15, 0)
{
  const all = alive()
  check(all.length >= 3, 'the lake\'s boulders carry crabs', JSON.stringify(crabs.stats))
  const homes = all.map(boulderOf)
  check(homes.every((b) => b && WANT.has(b.name)), 'every crab is on a lake-floor, shelf or beach boulder', [...new Set(homes.map((b) => b?.name ?? 'none'))].join(', '))
  check(BOULDERS.filter((b) => WANT.has(b.name)).every((b) => homes.includes(b)), 'each of the three qualifying boulders has at least one crab')
  check(!homes.some((b) => b.name === 'bank'), `the boulder ${BOULDERS[3].x - LAKE_R} m up the bank has none (band is ${SHORE_M} m)`)
  check(all.every((c) => Math.abs(c.y - stoneUnder(c)) < 1e-6), 'every crab sits on the stone\'s own surface', `${all.length} crabs`)
  check(all.every((c) => c.y > groundAt(c.x, c.z)), 'no crab is on or under the terrain')
  const mean = (name) => { const s = all.filter((c) => boulderOf(c).name === name).map((c) => c.size); return s.reduce((a, b) => a + b, 0) / s.length }
  const floor = mean('floor'), shelf = mean('shelf'), beach = mean('beach')
  check(floor > beach * 1.5 && beach <= SIZE_M[1] && floor <= SIZE_M[1] * DEEP_MUL, 'deep water makes larger crabs', `floor ${floor.toFixed(3)} m, shelf ${shelf.toFixed(3)} m, beach ${beach.toFixed(3)} m`)
  check(all.filter((c) => boulderOf(c).name === 'floor').every((c) => c.y < LEVEL), 'lake-floor crabs are under the water')
  const sizes = all.map((c) => c.size)
  check(Math.max(...sizes) - Math.min(...sizes) > 0.05, 'sizes vary', `${Math.min(...sizes).toFixed(3)}..${Math.max(...sizes).toFixed(3)} m`)
  check(crabs.overflow === 0 && crabs.saturated === 0, 'nothing was dropped for want of room')
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
  }
}
const ms = (performance.now() - t0) / (SECONDS / DT)
for (const [c, s] of start) if (Math.hypot(c.x - s.x, c.z - s.z) > 0.05) moved++
check(offStone === 0, 'no crab ever leaves the stone', `${offStone} frames`)
check(floating === 0, 'no crab ever floats above or sinks into it', `${floating} frames`)
check(offPerch === 0, 'no crab leaves its own rock\'s disc', `${offPerch} frames`)
check(moved > alive().length * 0.5, 'crabs crawl about', `${moved} of ${alive().length} moved`)
check(tilted > 0, 'crabs ride the stone\'s slope', `${tilted} tilted frames`)
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame, ${(rocks.calls / (SECONDS / DT)).toFixed(1)} surface queries/frame`)
check(crabs.mesh.count === alive().length, 'the instance count is the live count', `${crabs.mesh.count}`)

// --- rocks that land late ------------------------------------------------------
live = []
crabs.place(15, 0)
check(alive().length === 0, 'no rocks, no crabs')
live = BOULDERS
for (let i = 0; i < 400; i++) crabs.update(15, LEVEL + 1.6, 0, DT)
check(alive().length === snapA.length, 'a tile whose rocks landed after the scan gets its crabs on the rescan', `${alive().length} of ${snapA.length}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
