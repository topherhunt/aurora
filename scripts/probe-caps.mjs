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

const layers = { flattenAt: () => 0, dirtAt: () => 0, shoreAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

// Plate coverage in the near disc, MEASURED ON THE FACE AND NOT IN PLAN, which
// is the only version of the number that means anything on a cliff. Two
// corrections the plan version silently got wrong by a factor of four at 68
// degrees:
//
//   THE PLATE IS AN ELLIPSE, not a disc. An unrolled cap's footprint is
//   `measured.width` by `measured.depth` -- 2.0 by 1.21 -- and `instSpan` is the
//   LONG axis, so a disc of that diameter claims 1.65x the stone there is.
//
//   THE GROUND IS TILTED AND THE LATTICE IS NOT. A 2 m plan cell on a 68 degree
//   wall is 2.7 m2 of wall, not 4. The plate lies IN that wall (tilt: 1), so its
//   own area needs no such correction -- which is exactly why the two must not be
//   compared in the same frame.
//
// TWO NUMBERS, AND THE SECOND IS THE ONE TO TUNE AGAINST. `raw` is plate area
// over wall area and runs past 1 because plates overlap; `seen` rasters a 2 m
// plan lattice and asks each qualifying cell whether ANY plate is over it, which
// is the fraction of the wall a player finds clothed. They move in opposite
// directions under the dart -- spacing plates out cuts overlap and cuts `seen`
// with it -- so tuning on `raw` alone buys stacked plates and bare rock.
const coverage = (rocks, field, cx, cz, name) => {
  const bed = rocks.beds.find((b) => b.cfg.name === name)
  if (!bed) throw new Error(`no bed '${name}' -- it is 'enabled: false' in BEDS, so there is nothing to measure`)
  const R = bed.fullRadius
  const aspect = bed.shape.measured.depth / bed.shape.measured.width
  let plate = 0
  let n = 0
  const spans = []
  for (const t of bed.tiles.values()) {
    for (let i = 0; i < t.n; i++) {
      const id = t.ids[i]
      const dx = bed.instX[id] - cx
      const dz = bed.instZ[id] - cz
      if (dx * dx + dz * dz > R * R) continue
      const a = bed.instSpan[id] * 0.5
      plate += Math.PI * a * a * aspect
      spans.push(bed.instSpan[id])
      n++
    }
  }
  // The plate's shadow: its own ellipse, taken as the circle of equal area, with
  // the downhill axis foreshortened by hypot(tan, 1) because the plate lies IN
  // the wall (tilt 1). Without that the raster claims eleven times the plan a
  // plate has on an 85 degree face. No yaw is stored, so the circle is the
  // honest form of the question.
  const o0 = { h: 0, tan: 0 }
  const px = []
  const pz = []
  const pr = []
  for (const t of bed.tiles.values()) {
    for (let i = 0; i < t.n; i++) {
      const id = t.ids[i]
      const dx = bed.instX[id] - cx
      const dz = bed.instZ[id] - cz
      if (dx * dx + dz * dz > (R + 40) * (R + 40)) continue
      field.scatterAt(bed.instX[id], bed.instZ[id], 4, o0)
      px.push(dx)
      pz.push(dz)
      pr.push(bed.instSpan[id] * 0.5 * Math.sqrt(aspect / Math.hypot(o0.tan, 1)))
    }
  }
  spans.sort((a, b) => a - b)
  const at = (p) => (spans.length ? spans[Math.min(spans.length - 1, Math.floor(p * spans.length))].toFixed(1) : 'n/a')
  const o = { h: 0, tan: 0 }
  let ground = 0
  let clothed = 0
  for (let x = -R; x <= R; x += 2) {
    for (let z = -R; z <= R; z += 2) {
      if (x * x + z * z > R * R) continue
      field.scatterAt(cx + x, cz + z, 4, o)
      if (o.tan < bed.minSlopeTan || o.tan > bed.maxSlopeTan) continue
      const w = 4 * Math.hypot(o.tan, 1)
      ground += w
      for (let k = 0; k < px.length; k++) {
        const ex = px[k] - x
        const ez = pz[k] - z
        if (ex * ex + ez * ez < pr[k] * pr[k]) {
          clothed += w
          break
        }
      }
    }
  }
  console.log(
    `  ${name}: ${n} plates in the near ${R} m, ${plate.toFixed(0)} m2 of plate over ` +
      `${ground.toFixed(0)} m2 of qualifying WALL -- seen ${ground > 0 ? (clothed / ground).toFixed(2) : 'n/a'}` +
      ` raw ${ground > 0 ? (plate / ground).toFixed(2) : 'n/a'}` +
      `  span p10/50/90/max ${at(0.1)}/${at(0.5)}/${at(0.9)}/${spans.length ? spans[spans.length - 1].toFixed(1) : 'n/a'} m`
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
const dryWater = { levelAt: () => null, isSubmerged: () => false, shoreDistAt: (x, z, reach) => reach }

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
  coverage(rocks, field, s.x, s.z, 'cliff slabs')
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
  water: { levelAt: () => 70, isSubmerged: () => true, shoreDistAt: (x, z, reach) => reach },
}
{
  const rocks = new Rocks(new THREE.Scene(), lake.field, lake.water, layers, texArray, { seed: 7 })
  const t = performance.now()
  rocks.place(0, 0)
  report(rocks, `flat lake floor -- place ${(performance.now() - t).toFixed(0)} ms`)
  coverage(rocks, lake.field, 0, 0, 'bed caps')
  rocks.dispose()
}
