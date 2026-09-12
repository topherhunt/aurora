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
// `ladder` is the rock's own size in the metres `sizeByEnv` is written in --
// `shapeLod * instScale`, the longest axis, the same number `update` picks a LOD
// with. NOT `instSpan`, which is the rotated PLAN footprint the dart spaces on and
// reads smaller than the ladder whenever a quarter turn stands a rock on its short
// axis. Read this column against a bed's `sizeByEnv` range; they are in the same
// units and the percentiles should bracket it.
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
const dryWater = { levelAt: () => null, isSubmerged: () => false, shoreDistAt: (x, z, reach) => reach }

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
  console.log('  bed            ms    drawn      cand   samples    relief/asked  radius  ladder p10/50/90/max')
  let totMs = 0
  let totDrawn = 0
  for (const bed of rocks.beds) {
    bed.samples = 0
    bed.reliefs = 0
    bed.reliefAsks = 0
    const t = performance.now()
    bed.place(s.x, s.z)
    const ms = performance.now() - t
    const spans = []
    for (const tl of bed.tiles.values()) {
      for (let i = 0; i < tl.n; i++) spans.push(bed.shapeLod * bed.instScale[tl.ids[i]])
    }
    spans.sort((a, b) => a - b)
    const drawn = spans.length
    const at = (q) => (drawn ? spans[Math.floor(q * (drawn - 1))] : 0)
    const size = drawn
      ? `${at(0.1).toFixed(1)}/${at(0.5).toFixed(1)}/${at(0.9).toFixed(1)}/${at(1).toFixed(1)}`
      : '-'
    const cand = Object.values(bed.rejected).reduce((a, b) => a + b, 0) + drawn
    totMs += ms
    totDrawn += drawn
    console.log(
      `  ${bed.cfg.name.padEnd(12)}${ms.toFixed(0).padStart(6)}${String(drawn).padStart(9)}` +
      `${String(cand).padStart(10)}${String(bed.samples).padStart(10)}` +
      `${`${bed.reliefs}/${bed.reliefAsks}`.padStart(16)}${String(bed.radius).padStart(8)}` +
      `${size.padStart(20)}`
    )
  }
  console.log(`  ${'TOTAL'.padEnd(12)}${totMs.toFixed(0).padStart(6)}${String(totDrawn).padStart(9)}`)

  // AND WHAT IT COSTS TO WALK, which is the number that actually matters. The
  // total above is the ONE-OFF fill of every disc at boot. After that a bed only
  // grows the tiles that entering range creates, and refines the ones it already
  // holds as they come closer, so the standing cost is per metre travelled rather
  // than per square metre of disc. If these two figures were close, the beds would
  // be re-placing ground they had already placed.
  const walk = []
  for (let i = 1; i <= 200; i++) {
    const x = s.x + i
    const t = performance.now()
    rocks.update(x, field.heightAt(x, s.z) + 1.7, s.z)
    walk.push(performance.now() - t)
  }
  const total = walk.reduce((a, b) => a + b, 0)
  walk.sort((a, b) => a - b)
  const q = (p) => walk[Math.floor(p * (walk.length - 1))].toFixed(2)
  console.log(`  walking 200 m at 1 m a frame: p50 ${q(0.5)} ms  p90 ${q(0.9)} ms  worst ${q(1)} ms  ` +
    `${total.toFixed(0)} ms for the whole walk`)
  rocks.dispose()
}
