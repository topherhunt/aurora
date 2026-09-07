// Temporary: where the cap bed's place() time goes. Delete when tuned.
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

const run = (label, tweak) => {
  const rocks = new Rocks(new THREE.Scene(), field, dryWater, layers, texArray, { seed: 7 })
  const bed = rocks.beds.find((b) => b.cfg.name === 'cliff slabs')
  tweak(bed)
  const t = performance.now()
  rocks.place(-3335, -3115)
  const ms = performance.now() - t
  const b = rocks.stats.beds.find((x) => x.name === 'cliff slabs')
  console.log(`${label.padEnd(14)} ${ms.toFixed(0)} ms   tiles ${bed.tiles.size}  used ${b.used}  ${(ms / bed.tiles.size).toFixed(2)} ms/tile`)
  rocks.dispose()
}

run('warm', () => {})
run('as shipped', () => {})
run('as shipped', () => {})
run('no ladder', (b) => { b._fitFactor = () => 1 })
