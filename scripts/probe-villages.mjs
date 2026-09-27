// Count the leafkin villages in the shipped overworld (DESIGN.md §30): every
// entrance boulder the hollow rock bed grows and every mouth the entrances
// layer seats on one, over the whole 8192 m map.
//
//   node scripts/probe-villages.mjs [nearX,nearZ]
//
// The world is the shipped one -- public/world/height.png, layers.json and
// RELIEF_SHIPPED -- built the way src/v2/main.js builds it, minus the renderer.
// The hollow bed is a camera-following scatter, and a tile holds its boulder
// only at the level it is grown to within the bed's fullRadius (270 m): a tile
// first seen from further out is thin and `place` never thickens it. So the
// bed is emptied and its reach cut to 300 m before every place, the places
// are on a 250 m grid, and only the boulders within 125 m of each centre are
// gathered -- every one of those stands in a full tile. A boulder is keyed by
// its rounded position, since the scatter is a pure function of position and
// the same stone comes up under two centres.
// With `nearX,nearZ` the sites are listed nearest that spot first.

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { Entrances, mouthBankFrom } from '../src/v2/render/entrances.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { buildTextureArray } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import { LeafkinGround } from '../src/v2/render/leafkin-ground.js'
import { readFileSync } from 'node:fs'

const near = process.argv[2] ? process.argv[2].split(',').map(Number) : null
const STEP = 250

const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const height = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
height.setLayers(layers)
const water = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field: height })
water.rebuild()

const rocks = new Rocks(new THREE.Scene(), height, water, layers, buildTextureArray(), { seed: SEED })
const hollowBed = rocks.beds.find((b) => b.cfg.hollow)
// The screens walked over the field, water and rocks alone: the census counts mouths, not which end of a screen is open.
const entrances = new Entrances(new THREE.Scene(), height, water, rocks, { seed: SEED, radius: STEP, bank: mouthBankFrom(readShippedLadder('cave-mouth')), ground: new LeafkinGround({ field: height, water, rocks }) })

const hollows = new Map()
const sites = new Map()
const blind = new Set()
const out = new Float32Array(256 * 5)
const t0 = performance.now()
for (let z = -WORLD_HALF + STEP / 2; z < WORLD_HALF; z += STEP) {
  for (let x = -WORLD_HALF + STEP / 2; x < WORLD_HALF; x += STEP) {
    // The hollow bed alone: the other five beds are not asked for.
    for (const [key, t] of [...hollowBed.tiles]) hollowBed._evict(key, t)
    hollowBed.camTileX = null
    hollowBed.radius = 300
    hollowBed.place(x, z)
    entrances.place(x, z)
    const n = rocks.hollowsInto(x - STEP / 2, z - STEP / 2, x + STEP / 2, z + STEP / 2, out)
    for (let i = 0; i < n; i++) {
      const hx = out[i * 5], hz = out[i * 5 + 2]
      hollows.set(`${hx.toFixed(0)},${hz.toFixed(0)}`, { x: hx, z: hz, size: out[i * 5 + 4] })
    }
    for (const s of entrances.resident.values()) if (s.blind) blind.add(s.key); else sites.set(s.key, s)
  }
}
const ms = performance.now() - t0

const list = [...sites.values()]
if (near) list.sort((a, b) => Math.hypot(a.x - near[0], a.z - near[1]) - Math.hypot(b.x - near[0], b.z - near[1]))
else list.sort((a, b) => a.x - b.x || a.z - b.z)
console.log(`\n${hollows.size} entrance boulders in the overworld, ${list.length} with a mouth (${hollows.size - list.length} blind), in ${(ms / 1000).toFixed(1)} s`)
console.log(`  candidates refused: ${JSON.stringify(hollowBed.rejected)}`)
console.log(`  bearings refused: ${JSON.stringify(entrances.rejected)}\n`)
for (const h of hollows.values()) {
  if (!blind.has(`hollow:${h.x.toFixed(1)}:${h.z.toFixed(1)}`)) continue
  const g = height.heightAt(h.x, h.z), e = 3
  const tan = Math.hypot(height.heightAt(h.x + e, h.z) - height.heightAt(h.x - e, h.z), height.heightAt(h.x, h.z + e) - height.heightAt(h.x, h.z - e)) / (2 * e)
  console.log(`  blind ${h.x.toFixed(0).padStart(6)}, ${h.z.toFixed(0).padStart(6)}  size ${h.size.toFixed(1)} m  ground ${g.toFixed(0)} m  slope ${(Math.atan(tan) * 180 / Math.PI).toFixed(0)} deg`)
}
console.log('')
for (const s of list) {
  const d = near ? `  ${Math.hypot(s.x - near[0], s.z - near[1]).toFixed(0)} m away` : ''
  console.log(`  ${s.x.toFixed(0).padStart(6)}, ${s.z.toFixed(0).padStart(6)}  ground ${s.y.toFixed(0)} m  facing ${Math.round((Math.atan2(s.nx, s.nz) * 180) / Math.PI)} deg${d}`)
}
