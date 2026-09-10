// DO THE CLIFF PANELS COME OUT THE COLOUR OF THE CLIFF.
//
//   node scripts/probe-facade.mjs
//
// A facade bed's promise is arithmetic and this checks it against the shipped
// numbers rather than against a screenshot.
//
//   THE TERRAIN DRAWS gc * tile / ROCK_TILE_MEAN. terrain-material.js divides its
//   stone sample by uStoneMean and multiplies by the vertex shade.
//   A ROCK DRAWS tile * instColor. Same texture, same fragment, one multiply.
//
// So the two are the same colour exactly when instColor == gc / ROCK_TILE_MEAN,
// and the error is a per-channel ratio against that -- reported as a percentage,
// where 0 is a panel indistinguishable from the wall it lies on.
//
// The gc here is recomputed from the FIELD at each panel's own spot rather than
// read back out of the placer, so a panel that shaded itself off a stale sample
// shows up as error and not as agreement.
//
// TWO NUMBERS MATTER AND THEY ARE DIFFERENT QUESTIONS. `shade` is the whole error
// for lightness, which a facade is allowed and wants -- the jitter, and whatever
// the panel's own sample of the ground disagrees about. HUE is the one the bed
// exists to fix: the error with lightness divided out, which is what says "this
// panel is made of a different mineral than the mountain". A non-facade bed is
// reported beside it as the contrast, because a number with nothing to compare to
// is not a measurement.

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { buildTextureArray, ROCK_TILE_MEAN } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { Layers } from '../src/v2/layers/layers.js'
import { shade } from '../src/v2/terrain/chunk-mesh-v2.js'

const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
const dryWater = { levelAt: () => null, isSubmerged: () => false }

const BEDS = ['cliff slabs', 'giants', 'boulders']

const pct = (v) => `${(v * 100).toFixed(1)}%`

/** Every placed instance of one bed, as {drawn, want} colour pairs. */
const sample = (bed) => {
  const out = { h: 0, tan: 0 }
  const gc = [0, 0, 0]
  const col = new THREE.Color()
  const { altLo, altSpan } = field.bands
  const rows = []
  for (const t of bed.tiles.values()) {
    for (let i = 0; i < t.n; i++) {
      const id = t.ids[i]
      const x = bed.instX[id]
      const z = bed.instZ[id]
      field.scatterAt(x, z, 4, out)
      shade(out.h, 1 / Math.hypot(out.tan, 1), field.snowLineAt(x, z), layers.snow.band,
        layers.flattenAt(x, z), altLo, altSpan, x, z, gc, 0)
      bed.batch.getColorAt(id, col)
      rows.push({
        drawn: [col.r, col.g, col.b],
        want: [gc[0] / ROCK_TILE_MEAN[0], gc[1] / ROCK_TILE_MEAN[1], gc[2] / ROCK_TILE_MEAN[2]],
      })
    }
  }
  return rows
}

/**
 * The error of one bed, split into the part that is lightness and the part that
 * is hue. Lightness is the mean of the three channel ratios; hue is what is left
 * once that mean is divided out, which is why a bed that is uniformly too bright
 * scores zero here and a bed that is too RED does not.
 */
const score = (rows) => {
  let lumSum = 0
  let hueSum = 0
  let hueMax = 0
  let lumMin = Infinity
  let lumMax = 0
  for (const { drawn, want } of rows) {
    const r = [drawn[0] / want[0], drawn[1] / want[1], drawn[2] / want[2]]
    const lum = (r[0] + r[1] + r[2]) / 3
    let hue = 0
    for (let c = 0; c < 3; c++) hue = Math.max(hue, Math.abs(r[c] / lum - 1))
    lumSum += Math.abs(lum - 1)
    hueSum += hue
    if (hue > hueMax) hueMax = hue
    if (lum < lumMin) lumMin = lum
    if (lum > lumMax) lumMax = lum
  }
  const n = rows.length
  return { n, lum: lumSum / n, lumMin, lumMax, hue: hueSum / n, hueMax }
}

// The steepest cell a sweep of the map can find -- the wall the panels are for.
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
  rocks.place(s.x, s.z)
  console.log(`\n=== ${s.x}, ${s.z} -- a ${((Math.atan(s.tan) * 180) / Math.PI).toFixed(0)} degree face ===`)
  for (const name of BEDS) {
    const bed = rocks.beds.find((b) => b.cfg.name === name)
    const rows = sample(bed)
    if (!rows.length) {
      console.log(`  ${name.padEnd(12)} nothing placed`)
      continue
    }
    const q = score(rows)
    console.log(
      `  ${name.padEnd(12)}${bed.facade ? 'facade ' : '       '}${String(q.n).padStart(6)} placed` +
      `   hue err mean ${pct(q.hue)} worst ${pct(q.hueMax)}` +
      `   shade ${pct(q.lum)} over ${q.lumMin.toFixed(2)}-${q.lumMax.toFixed(2)}x`
    )
  }
  rocks.dispose()
}
