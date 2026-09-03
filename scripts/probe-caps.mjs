// THROWAWAY. Pool, yield and reject mix for the two cap beds in rocks.js.
//
//   node scripts/probe-caps.mjs
//
// The cliff bed is measured on the REAL heightmap, because it is the only thing
// that has real faces in it -- a stub world has one slope everywhere and the
// footprint probe has nothing to reject. The bed bed is measured on a flat
// submerged stub, which is what a lake floor actually is.

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { buildTextureArray } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { Layers } from '../src/v2/layers/layers.js'

const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

// Plate coverage in the near disc: how much of the ground the bed is ALLOWED to
// cover has a cap on it. Ground area is sampled on a 2 m lattice and counted
// only where the slope is inside the bed's own window; plate area is the
// footprint the bed recorded per instance. Over 1 means plates overlap.
const coverage = (rocks, field, cx, cz, name) => {
  const bed = rocks.beds.find((b) => b.cfg.name === name)
  const R = bed.fullRadius
  let plate = 0
  let n = 0
  for (const t of bed.tiles.values()) {
    for (let i = 0; i < t.n; i++) {
      const id = t.ids[i]
      const dx = bed.instX[id] - cx
      const dz = bed.instZ[id] - cz
      if (dx * dx + dz * dz > R * R) continue
      plate += Math.PI * (bed.instSpan[id] * 0.5) ** 2
      n++
    }
  }
  const o = { h: 0, tan: 0 }
  let ground = 0
  for (let x = -R; x <= R; x += 2) {
    for (let z = -R; z <= R; z += 2) {
      if (x * x + z * z > R * R) continue
      field.scatterAt(cx + x, cz + z, 4, o)
      if (o.tan >= bed.minSlopeTan && o.tan <= bed.maxSlopeTan) ground += 4
    }
  }
  console.log(
    `  ${name}: ${n} plates in the near ${R} m, ${plate.toFixed(0)} m2 of plate over ` +
      `${ground.toFixed(0)} m2 of qualifying ground -- cover ${ground > 0 ? (plate / ground).toFixed(2) : 'n/a'}`
  )
}

const report = (rocks, where) => {
  console.log(`\n=== ${where} ===\n`)
  for (const bed of rocks.beds) {
    const r = bed.rejected
    const mix = Object.entries(r).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' ')
    console.log(
      `  ${bed.cfg.name.padEnd(12)} pool ${String(bed.maxInstances).padStart(6)}  ` +
        `placed ${String(bed.maxInstances - bed.freeCount).padStart(6)}  ` +
        `samples ${String(bed.samples).padStart(7)}  | ${mix}`
    )
  }
}

// --- the real field ----------------------------------------------------------
const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
const dryWater = { levelAt: () => null, isSubmerged: () => false }

// Three spots, so the answer is not one valley's. Picked by slope: the sampler
// below walks the map and takes the steepest cells it finds.
const out = { h: 0, tan: 0 }
const spots = []
for (let i = 0; i < 4000; i++) {
  const x = (i * 977) % 8000 - 4000
  const z = (i * 1613) % 8000 - 4000
  field.scatterAt(x, z, 4, out)
  spots.push({ x, z, tan: out.tan })
}
spots.sort((a, b) => b.tan - a.tan)
for (const s of [spots[0], spots[40], spots[400]]) {
  const rocks = new Rocks(new THREE.Scene(), field, dryWater, layers, texArray, { seed: 7 })
  const t = performance.now()
  rocks.place(s.x, s.z)
  const ms = performance.now() - t
  report(rocks, `real field at ${s.x}, ${s.z} (slope ${((Math.atan(s.tan) * 180) / Math.PI).toFixed(0)} deg) -- place ${ms.toFixed(0)} ms`)
  coverage(rocks, field, s.x, s.z, 'cliff caps')
  field.scatterAt(s.x, s.z, 4, out)
  rocks.update(s.x, out.h + 2, s.z)
  const st = rocks.stats
  console.log(`  tris ${st.tris}  drawn ${st.beds.reduce((a, b) => a + b.drawn, 0)}  ` +
    st.beds.map((b) => `${b.name} ${b.tris}`).join(' | '))
  rocks.dispose()
}

// --- a flat lake floor -------------------------------------------------------
const lake = {
  field: {
    scatterAt: (x, z, cell, o) => { o.h = 60; o.tan = 0.05; return o },
    heightAt: () => 60,
    snowLineAt: () => 9999,
    bands: { altLo: 0, altSpan: 900 },
  },
  water: { levelAt: () => 70, isSubmerged: () => true },
}
{
  const rocks = new Rocks(new THREE.Scene(), lake.field, lake.water, layers, texArray, { seed: 7 })
  const t = performance.now()
  rocks.place(0, 0)
  report(rocks, `flat lake floor -- place ${(performance.now() - t).toFixed(0)} ms`)
  coverage(rocks, lake.field, 0, 0, 'bed caps')
  rocks.dispose()
}
