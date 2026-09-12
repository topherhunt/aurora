// Node-side gates for the frogs (src/v2/render/frogs.js).
//
//   node scripts/check-frogs.mjs
//
// The scatter runs against a synthetic world: flat ground at y = 10 with a
// straight river along z at x = 0 (banks at |x| = 4), the snow line dropping to
// the ground for z > 60 (cold), and one boulder at (8, 0). Everything below is
// a way a frog can go wrong without anything throwing: a frog in the water, in
// the cold, on the boulder or past the shore band; a shore with the wrong
// number of frogs for the density; frogs all one size or one colour; a frog
// that hops off the band or into the river, that never hops, that drifts away
// from where it was placed; a scatter that is not the same twice; a frame that
// costs more than a scatter is allowed to. The shipped GLB is checked for
// existence and shape too, because the world loads it by name.
//
// What this can NOT check: whether they look like frogs, or how the hop reads.
// That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Frogs, DENSITY, TILE, SHORE_M, SIZE_M, MAX } from '../src/v2/render/frogs.js'
import { CRITTER_GLB } from '../src/v2/render/critters.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic world -----------------------------------------------------
const GROUND = 10
const HALF = 4
const COLD_Z = 60
const ROCK = { x: 8, z: 0, r: 1.5, top: 11 }
const inRock = (x, z) => Math.hypot(x - ROCK.x, z - ROCK.z) < ROCK.r
const height = {
  heightAt: () => GROUND,
  heightAndSlopeAt: () => ({ h: GROUND, tan: 0, gx: 0, gz: 0 }),
  // Warm everywhere but the far end, where the snow reaches the ground.
  snowLineAt: (x, z) => (z > COLD_Z ? GROUND : GROUND + 500),
}
const water = {
  levelAt: (x) => (Math.abs(x) < HALF ? GROUND + 0.5 : null),
  isSubmerged(x, z, g) { const l = this.levelAt(x, z); return l !== null && g < l },
  shoreDistAt(x, z, reach) {
    if (!(reach > 0)) throw new Error('reach')
    const d = Math.abs(x) - HALF
    return d > reach ? reach : d < -reach ? -reach : d
  },
}
const rocks = { blockTopAt: (x, z) => (inRock(x, z) ? ROCK.top : -Infinity) }
// A drawn surface a hand above the field, to see the frogs seat on it rather than the field.
const ground = { groundAt: () => GROUND + 0.05 }

// --- the shipped asset -------------------------------------------------------
{
  const file = new URL(`../public/${CRITTER_GLB.frog}`, import.meta.url)
  check(fs.existsSync(file), `${CRITTER_GLB.frog} is shipped -- run tools/creatures/ship.mjs`)
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file)
    check(buf.toString('latin1', 0, 4) === 'glTF', 'the frog GLB has a glTF header')
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
    check(json.meshes?.length === 1 && json.meshes[0].primitives.length === 1, 'one mesh, one primitive', `${json.meshes?.length} meshes`)
    check(json.images?.length >= 1 && json.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture !== undefined, 'a base colour texture to draw')
  }
}

// --- a stand-in asset: a unit box, feet at y = 0 -----------------------------
const box = new THREE.BoxGeometry(1, 0.5, 0.7).translate(0, 0.25, 0)
const asset = {
  pos: box.getAttribute('position').array,
  nrm: box.getAttribute('normal').array,
  uv: box.getAttribute('uv').array,
  idx: Array.from(box.index.array),
  map: null,
}

// --- construction ------------------------------------------------------------
const scene = new THREE.Scene()
const frogs = new Frogs(scene, height, water, { seed: 7, rocks, ground, assets: asset })
check(frogs.loaded && frogs.mesh.visible && Math.abs(frogs.span - 1) < 1e-6, 'asset set: visible, span 1', `span ${frogs.span}`)
check(frogs.mesh.instanceColor && frogs.mesh.instanceColor.isInstancedBufferAttribute, 'tint rides in instanceColor')

// --- placement ---------------------------------------------------------------
const alive = () => frogs.slots.filter((f) => f.tile !== null)
frogs.place(0, 0)
{
  const all = alive()
  check(all.length > 20, 'the river bank fills with frogs', JSON.stringify(frogs.stats))
  check(all.every((f) => Math.abs(f.x) >= HALF), 'no frog in the river', `${all.filter((f) => Math.abs(f.x) < HALF).length} wet`)
  check(all.every((f) => Math.abs(f.x) < HALF + SHORE_M), `every frog within ${SHORE_M} m of the bank`, `furthest ${Math.max(...all.map((f) => Math.abs(f.x) - HALF)).toFixed(2)} m`)
  check(all.every((f) => !inRock(f.x, f.z)), 'no frog on the boulder')
  check(all.every((f) => Math.abs(f.y - (GROUND + 0.05)) < 1e-6), 'frogs seat on the drawn ground, not the field')
  // Expected count: a SHORE_M band on each bank, as long as the column of resident tiles along the river, at DENSITY.
  const rows = [...frogs.tiles.values()].filter((t) => t.tx === 0).length
  const expected = DENSITY * 2 * SHORE_M * rows * TILE
  check(all.length > expected * 0.6 && all.length < expected * 1.4, 'the count is about the density times the band', `${all.length} frogs, ~${expected.toFixed(0)} expected over ${rows * TILE} m of bank`)
  const sizes = all.map((f) => f.size)
  check(Math.min(...sizes) >= SIZE_M[0] && Math.max(...sizes) <= SIZE_M[1] && Math.max(...sizes) - Math.min(...sizes) > 0.03, 'sizes vary across the range', `${Math.min(...sizes).toFixed(3)}..${Math.max(...sizes).toFixed(3)} m`)
  const tints = new Set(all.map((f) => `${f.r.toFixed(2)},${f.g.toFixed(2)},${f.b.toFixed(2)}`))
  check(tints.size > all.length * 0.8, 'tints vary', `${tints.size} distinct of ${all.length}`)
  check(frogs.overflow === 0, 'the pool was not saturated', `${MAX} slots`)
}
// Cold: standing on the boundary, the warm half has frogs and the cold half none.
frogs.place(0, COLD_Z)
{
  const all = alive()
  check(all.length > 0 && all.every((f) => f.z <= COLD_Z), 'no frog where the snow line is at the ground', `${all.length} frogs on the warm side, ${all.filter((f) => f.z > COLD_Z).length} on the cold`)
}
// Determinism: the same tile, the same frogs.
frogs.place(0, 0)
const snapA = alive().map((f) => [f.homeX, f.homeZ, f.size, f.r]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
frogs.place(50, 50)
frogs.place(0, 0)
const snapB = alive().map((f) => [f.homeX, f.homeZ, f.size, f.r]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
check(JSON.stringify(snapA) === JSON.stringify(snapB), 'placement is a pure function of position', `${snapA.length} frogs`)

// --- the run ---------------------------------------------------------------------
const DT = 1 / 72
const SECONDS = 60
const homes = new Map(alive().map((f) => [f, { x: f.homeX, z: f.homeZ }]))
let hopped = 0
let wet = 0
let offBand = 0
let onRock = 0
let strayed = 0
let maxStray = 0
const t0 = performance.now()
for (let i = 0; i < SECONDS / DT; i++) {
  frogs.update(0, GROUND + 1.6, 0, DT)
  for (const f of alive()) {
    if (f.state === 'hop') hopped++
    if (Math.abs(f.x) < HALF) wet++
    if (Math.abs(f.x) >= HALF + SHORE_M) offBand++
    if (inRock(f.x, f.z) && f.state === 'sit') onRock++
    const home = homes.get(f)
    if (home) {
      const d = Math.hypot(f.x - home.x, f.z - home.z)
      if (d > maxStray) maxStray = d
      if (d > 5) strayed++
    }
  }
}
const ms = (performance.now() - t0) / (SECONDS / DT)
check(hopped > 0, 'frogs hop', `${hopped} hop-frames`)
check(wet === 0, 'no frog ever lands in the river', `${wet} wet frames`)
check(offBand === 0, 'no frog hops off the shore band', `${offBand} frames`)
check(onRock === 0, 'no frog sits on the boulder', `${onRock} frames`)
check(strayed === 0, 'frogs stay near where they were placed', `furthest ${maxStray.toFixed(2)} m`)
check(alive().every((f) => f.state !== 'sit' || Math.abs(f.y - (GROUND + 0.05)) < 1e-6), 'a sitting frog is on the ground')
check(ms < 1.5, 'a frame costs well under a scatter', `${ms.toFixed(3)} ms/frame with ${alive().length} frogs`)
check(frogs.mesh.count === alive().length, 'the instance count is the live count', `${frogs.mesh.count}`)

// Dry land far from any water: nothing.
frogs.place(500, 0)
frogs.update(500, GROUND, 0, DT)
check(alive().length === 0 && frogs.mesh.count === 0, 'no frogs away from water', `${alive().length} alive, count ${frogs.mesh.count}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
