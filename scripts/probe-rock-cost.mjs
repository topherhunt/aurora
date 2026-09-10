// WHAT EACH ROCK BED COSTS TO PLACE, AND WHAT IT GETS FOR IT.
//
//   node scripts/probe-rock-cost.mjs
//
// One boot-time `place` per bed on the real world, at a spot on a real cliff.
// The columns are the whole question: `ms` is what the bed costs to fill its
// disc, `drawn` is how many instances it has to show for it, and `cand` is how
// many candidate sites it walked to find them -- the gap between `cand` and
// `drawn` is work spent on rocks that do not exist.
//
// `samples` is the subset of candidates that reached a field query, which is the
// expensive part (~1 us each against ~11 rand() calls for one that does not).
//
// Not a gate. A before/after for a bed's cost, run by hand.

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { buildTextureArray } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { Layers } from '../src/v2/layers/layers.js'

const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
const dryWater = { levelAt: () => null, isSubmerged: () => false }

const out = { h: 0, tan: 0 }
const spots = []
for (let i = 0; i < 4000; i++) {
  const x = ((i * 977) % 8000) - 4000
  const z = ((i * 1613) % 8000) - 4000
  field.scatterAt(x, z, 4, out)
  spots.push({ x, z, tan: out.tan })
}
spots.sort((a, b) => b.tan - a.tan)

for (const s of [spots[0], spots[400]]) {
  const rocks = new Rocks(new THREE.Scene(), field, dryWater, layers, texArray, { seed: 7 })
  console.log(`\n=== ${s.x}, ${s.z} -- a ${((Math.atan(s.tan) * 180) / Math.PI).toFixed(0)} degree face ===`)
  console.log('  bed            ms    drawn      cand   samples   tiles  radius   ms/1k drawn')
  let totMs = 0
  let totDrawn = 0
  for (const bed of rocks.beds) {
    bed.samples = 0
    const t = performance.now()
    bed.place(s.x, s.z)
    const ms = performance.now() - t
    let drawn = 0
    for (const tl of bed.tiles.values()) drawn += tl.n
    const cand = Object.values(bed.rejected).reduce((a, b) => a + b, 0) + drawn
    totMs += ms
    totDrawn += drawn
    console.log(
      `  ${bed.cfg.name.padEnd(12)}${ms.toFixed(0).padStart(6)}${String(drawn).padStart(9)}` +
      `${String(cand).padStart(10)}${String(bed.samples).padStart(10)}` +
      `${String(bed.tiles.size).padStart(8)}${String(bed.radius).padStart(8)}` +
      `${(drawn ? (ms * 1000) / drawn : 0).toFixed(1).padStart(14)}`
    )
  }
  console.log(`  ${'TOTAL'.padEnd(12)}${totMs.toFixed(0).padStart(6)}${String(totDrawn).padStart(9)}`)
  rocks.dispose()
}
