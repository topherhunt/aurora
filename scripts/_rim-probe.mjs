// Why the glade's rim carries no trees: the ground, its slope, the biome's
// cover and the forest law's keep-probability, sampled out along five bearings.
//
//   node scripts/_rim-probe.mjs [door key]

import * as THREE from 'three'

import { SEED } from '../src/v2/config.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { validate } from '../src/v2/layers/doc.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { buildTextureArray } from '../src/textures.js'
import { Shell } from '../src/v2/render/shell.js'
import { HOUSE_BOUNDS } from '../src/v2/render/room-props.js'
import { buildVillage, rollVillage } from '../src/v2/rooms/village.js'
import { PLACEMENT, forestKeepAt } from '../src/v2/layers/forest.js'
import { keyHash } from '../src/sim/score.js'

const KEY = process.argv[2] ?? 'hollow:160.0:-356.0'
const spec = rollVillage(keyHash(KEY), HOUSE_BOUNDS)
const shell = new Shell(new THREE.Scene(), buildRockBank(), buildTextureArray(), spec.shell)
const room = buildVillage({ spec, shell, house: HOUSE_BOUNDS })
const layers = Layers.deserialize(validate(room.doc))
const field = new V2Height({ heightmap: room.heightmap, layers, seed: SEED, relief: RELIEF_SHIPPED })

const maxTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
console.log(`bounds ${JSON.stringify(room.ground.bounds)}  slope limit ${PLACEMENT.maxSlopeDeg} deg (tan ${maxTan.toFixed(2)})  minElev ${PLACEMENT.minElev}`)
const out = { h: 0, tan: 0 }
for (const deg of [0, 72, 144, 216, 288]) {
  const a = (deg * Math.PI) / 180
  const rim = room.ground.rimAt(a)
  const rows = []
  let last = null
  for (let d = Math.max(0, rim - 30); d <= rim + 4; d += 1) {
    const x = Math.cos(a) * d, z = Math.sin(a) * d
    field.scatterAt(x, z, 4, out)
    const keep = forestKeepAt(out.h, out.tan, out.h - field.snowLineAt(x, z), null, x, z)
    if (keep > 0) last = d
    rows.push(`  d ${d.toFixed(0).padStart(3)}  h ${out.h.toFixed(1).padStart(6)}  tan ${out.tan.toFixed(2).padStart(5)}  keep ${keep.toFixed(2)}`)
  }
  console.log(`\nbearing ${deg}: rim ${rim.toFixed(1)} m, the last ground a tree may stand on ${last === null ? 'none' : `${last} m (${(rim - last).toFixed(0)} m short of the rim)`}`)
  console.log(rows.join('\n'))
}
