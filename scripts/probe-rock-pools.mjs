// Measure what each rock bed's instance pool actually needs on the shipped
// world, so `siteFrac` in src/v2/render/rocks.js can be set from a number
// rather than an estimate.
//
//   node scripts/probe-rock-pools.mjs [stride=50] [row=100]
//
// Flies the camera over the whole world at ground level in a serpentine --
// `stride` metres a step along rows `row` metres apart -- growing every bed
// synchronously at each step, then thickening the tiles the walk asked to
// (see the traverse in scripts/check-rocks.mjs for why that takes a second
// `place`). The prop clock is advanced two seconds a step so cross-dissolve
// ghosts retire as they would in play rather than piling up in the pool.
//
// Reports, per bed, the peak of `maxInstances - freeCount` over the flight and
// where it happened, against the pool the bed allocated, and the `siteFrac`
// that would size the pool to that peak with 50% headroom. A bed that ran dry
// during the flight is named: its `siteFrac` is too low for this world.
//
// The world is the shipped one -- public/world/height.png, layers.json and
// RELIEF_SHIPPED -- built the way src/v2/main.js builds it, minus the renderer.
// The water surfaces need a Water for its material and group; a bare
// ShaderMaterial and Group stand in, since nothing here draws.

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { buildTextureArray } from '../src/textures.js'
import { setPropClock } from '../src/material.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'
import { readFileSync } from 'node:fs'

const STRIDE = Number(process.argv[2] ?? 50)
const ROW = Number(process.argv[3] ?? 100)
const HEADROOM = 1.5
const MARGIN = 100

const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const height = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
height.setLayers(layers)
const water = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers })
water.rebuild()

const rocks = new Rocks(new THREE.Scene(), height, water, layers, buildTextureArray(), { seed: SEED })

const peak = rocks.beds.map(() => ({ used: 0, x: 0, z: 0 }))
const lo = -WORLD_HALF + MARGIN
const hi = WORLD_HALF - MARGIN
let steps = 0
let clock = 0
const t0 = performance.now()
for (let z = lo, row = 0; z <= hi; z += ROW, row++) {
  const xs = []
  for (let x = lo; x <= hi; x += STRIDE) xs.push(x)
  if (row & 1) xs.reverse()
  for (const x of xs) {
    const y = height.heightAt(x, z) + 1.6
    clock += 2
    setPropClock(clock)
    rocks.place(x, z)
    for (const bed of rocks.beds) bed.walkAll = true
    rocks.update(x, y, z)
    rocks.place(x, z)
    for (const bed of rocks.beds) bed.walkAll = true
    rocks.update(x, y, z)
    rocks.beds.forEach((bed, i) => {
      const used = bed.maxInstances - bed.freeCount
      if (used > peak[i].used) peak[i] = { used, x, z }
    })
    steps++
  }
  if (row % 10 === 0) {
    const secs = (performance.now() - t0) / 1000
    console.error(`row ${row} z ${z} -- ${steps} steps in ${secs.toFixed(0)} s`)
  }
}

console.log(`\n${steps} camera stations, stride ${STRIDE} m, rows ${ROW} m apart, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`)
console.log('bed        siteFrac   pool    peak  fill   at (x, z)          suggest siteFrac (peak x ' + HEADROOM + ')   dropped')
for (let i = 0; i < rocks.beds.length; i++) {
  const bed = rocks.beds[i]
  const p = peak[i]
  const boundAtOne = bed.maxInstances / bed.siteFrac
  const suggest = (p.used * HEADROOM) / boundAtOne
  console.log(
    `${bed.cfg.name.padEnd(10)} ${bed.siteFrac.toFixed(3).padStart(8)} ${String(bed.maxInstances).padStart(6)} ` +
    `${String(p.used).padStart(7)} ${((p.used / bed.maxInstances) * 100).toFixed(0).padStart(4)}%  ` +
    `(${String(p.x).padStart(5)}, ${String(p.z).padStart(5)})   ${suggest.toFixed(3).padStart(20)}` +
    `   ${bed.rejected.pool ? `${bed.rejected.pool} rocks -- pool ran dry` : '0'}`
  )
}
