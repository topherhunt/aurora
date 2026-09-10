// DOES EVERY CLIFF FACE GET A PLATE, AND DO THE PLATES STAY OFF EACH OTHER.
//
//   node scripts/probe-mask.mjs [bed,bed]
//
// The contract the cap bed is written to has two halves and this measures both.
//
//   EVERY CONTIGUOUS FACE 5 M ACROSS OR WIDER HOLDS A PLATE CENTRE. The map is
//   flood-filled in plan into contiguous runs of qualifying slope, each run is
//   sized as the circle of equal WALL area, and a run that is five metres across
//   and holds no plate centre is a miss. That is the promise stated as a number,
//   and the count of misses is the headline.
//
//   AND NO TWO PLATES OVERLAP BY MORE THAN A TENTH. Overlap is the cheap centre-
//   radius one the placer itself uses: 1 - d / (r + ro), over the plates' own
//   in-plane radii and in THREE dimensions, so a pair reading 0.10 is two discs
//   touching with the seam shut and anything past it is stone paid for twice.
//
// Everything else here is context for those two. The masked fraction says how
// much wall the plates actually clothe; the bare runs say whether what is left is
// a rim of seams or a hole in the middle of a face; and the fit column separates
// wall no candidate reached from wall `_fitFactor` will not lay any plate on.
//
// The lattice is 2 m in PLAN and every cell is weighted by hypot(tan, 1), so what
// is reported is the fraction of WALL and not of map. A plate covers a cell when
// the cell's ground point is within the plate's own face radius of the plate's, IN
// THREE DIMENSIONS -- the same metric the placer packs by, so what is measured here
// is the rule as shipped rather than its shadow on the map.

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { buildTextureArray } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { Layers } from '../src/v2/layers/layers.js'

// The burial ceiling in rocks.js. Not exported, and the probe wants the most
// generous budget the placer could ever have handed a plate here -- the question
// is whether the GROUND allows a plate, not whether one roll of the sink did.
const SINK_CAP = 0.92
const CELL = 2
// The face the promise is made about, as a diameter in metres of WALL.
const FACE_MIN = 5

const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
const dryWater = { levelAt: () => null, isSubmerged: () => false }

// Which beds count as cover. Overridable, so a bed can be measured on its own or
// a new one folded in without editing this file.
const CAP_BEDS = (process.argv[2] || 'cliff slabs').split(',')

/** Every plate of every cap bed near the spot, as a disc on the face it lies in. */
const platesNear = (rocks, cx, cz, R) => {
  const out = []
  for (const name of CAP_BEDS) {
    const bed = rocks.beds.find((b) => b.cfg.name === name)
    if (!bed) continue
    for (const [key, t] of bed.tiles) {
      for (let i = 0; i < t.n; i++) {
        const id = t.ids[i]
        const dx = bed.instX[id] - cx
        const dz = bed.instZ[id] - cz
        if (dx * dx + dz * dz > (R + 60) * (R + 60)) continue
        out.push({
          x: dx,
          z: dz,
          y: bed.instY[id] + bed.instSink[id],
          r: bed._faceRadius(bed.instSpan[id]),
          span: bed.instSpan[id],
          bed: name,
          tile: key,
        })
      }
    }
  }
  return out
}

/**
 * The widest plate the GROUND at (x, z) would take, asked of the bed's own probe
 * with no neighbours in it. Zero means the fit ladder bottoms out: that cell
 * cannot hold a plate of this bed's floor size however many candidates land on it.
 */
const groundHolds = (bed, x, z) => {
  const m = bed.shape.measured
  const o = bed.field.scatterAt(x, z, 4, { h: 0, tan: 0 })
  if (o.tan < bed.minSlopeTan || o.tan > bed.maxSlopeTan) return 0
  const top = bed.cfg.sizeByEnv.cliff[1]
  // Per metre of span and along the plate's normal, as _growTile quotes it: the
  // burial is a fixed fraction of the shell's own height applied down world Y,
  // the skirt already hangs along that normal.
  const dropPerSpan =
    (m.height * SINK_CAP) / m.width / Math.hypot(o.tan, 1) + bed.shapeSkirt / m.width
  return top * bed._fitFactor(x, z, 0, top, dropPerSpan, [], 0)
}

/**
 * Flood-fill a boolean plan grid into 4-connected runs, returning one entry per
 * run with its wall area and its member cells. Iterative on an explicit stack --
 * a face on this map runs to hundreds of thousands of cells and recursion blows
 * the stack well before that.
 */
const runs = (w, h, keep, weight) => {
  const seen = new Uint8Array(w * h)
  const out = []
  const stack = []
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !keep[s]) continue
    const cells = []
    let area = 0
    seen[s] = 1
    stack.push(s)
    while (stack.length) {
      const i = stack.pop()
      cells.push(i)
      area += weight[i]
      const ix = i % w
      const iz = (i / w) | 0
      if (ix > 0 && !seen[i - 1] && keep[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
      if (ix < w - 1 && !seen[i + 1] && keep[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
      if (iz > 0 && !seen[i - w] && keep[i - w]) { seen[i - w] = 1; stack.push(i - w) }
      if (iz < h - 1 && !seen[i + w] && keep[i + w]) { seen[i + w] = 1; stack.push(i + w) }
    }
    out.push({ cells, area, dia: 2 * Math.sqrt(area / Math.PI) })
  }
  return out
}

const report = (rocks, cx, cz, label) => {
  const slabs = rocks.beds.find((b) => b.cfg.name === 'cliff slabs')
  const R = slabs.fullRadius
  const near = platesNear(rocks, cx, cz, R)

  const N = Math.floor((2 * R) / CELL) + 1
  const idx = (x, z) => ((z + R) / CELL) * N + (x + R) / CELL
  const isWall = new Uint8Array(N * N)
  const isBare = new Uint8Array(N * N)
  const weight = new Float32Array(N * N)

  let wall = 0
  let masked = 0
  let refused = 0
  let missed = 0
  for (let x = -R; x <= R; x += CELL) {
    for (let z = -R; z <= R; z += CELL) {
      if (x * x + z * z > R * R) continue
      const o = field.scatterAt(cx + x, cz + z, 4, { h: 0, tan: 0 })
      if (o.tan < slabs.minSlopeTan || o.tan > slabs.maxSlopeTan) continue
      const w = CELL * CELL * Math.hypot(o.tan, 1)
      const i = idx(x, z)
      isWall[i] = 1
      weight[i] = w
      wall += w
      let hit = false
      for (const p of near) {
        const ex = p.x - x
        const ey = p.y - o.h
        const ez = p.z - z
        if (ex * ex + ey * ey + ez * ez < p.r * p.r) {
          hit = true
          break
        }
      }
      if (hit) masked += w
      else {
        isBare[i] = 1
        if (groundHolds(slabs, cx + x, cz + z) > 0) missed += w
        else refused += w
      }
    }
  }

  // THE PROMISE. A face is a contiguous run of qualifying slope; it is kept if a
  // plate CENTRE lands in one of its cells, which is the rule as written and not
  // a proxy for it.
  const faces = runs(N, N, isWall, weight)
  const held = new Uint8Array(N * N)
  for (const p of near) {
    const gx = Math.round(p.x / CELL) * CELL
    const gz = Math.round(p.z / CELL) * CELL
    if (Math.abs(gx) > R || Math.abs(gz) > R) continue
    held[idx(gx, gz)] = 1
  }
  const big = faces.filter((f) => f.dia >= FACE_MIN)
  const missedFaces = big.filter((f) => !f.cells.some((i) => held[i]))
  const missedArea = missedFaces.reduce((a, f) => a + f.area, 0)
  const bigArea = big.reduce((a, f) => a + f.area, 0)

  // AND WHAT IS LEFT BARE, as runs rather than as a percentage: a tenth spread as
  // seams between plates is the jagged edge that is wanted, and the same tenth in
  // one hole is a face nothing was laid on.
  const gaps = runs(N, N, isBare, weight).sort((a, b) => b.dia - a.dia)

  // THE OVERLAP CEILING, on the placer's own cheap metric. O(n^2) over a few
  // hundred plates is nothing next to the field sampling above.
  let worst = 0
  let over = 0
  let overSeam = 0
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const d = Math.hypot(near[i].x - near[j].x, near[i].y - near[j].y, near[i].z - near[j].z)
      const f = 1 - d / (near[i].r + near[j].r)
      if (f <= 0) continue
      if (f > worst) worst = f
      if (f > 0.1005) {
        over++
        if (near[i].tile !== near[j].tile) overSeam++
      }
    }
  }

  const spans = near.map((p) => p.span).sort((a, b) => a - b)
  const at = (q) => (spans.length ? spans[Math.floor(q * (spans.length - 1))] : NaN)
  const byBed = CAP_BEDS.map(
    (n) => `${n} ${near.filter((p) => p.bed === n).length}`
  ).join(', ')
  const pct = (v) => ((v / wall) * 100).toFixed(1)
  console.log(
    `\n=== ${label} ===\n` +
      `  ${missedFaces.length} of ${big.length} faces over ${FACE_MIN} m across hold no plate` +
      `   (${((missedArea / bigArea) * 100).toFixed(1)}% of that wall, widest miss ` +
      `${(missedFaces[0] ? Math.max(...missedFaces.map((f) => f.dia)) : 0).toFixed(0)} m)\n` +
      `  worst overlapping pair ${(worst * 100).toFixed(1)}%, ${over} pairs past the tenth ` +
      `(${overSeam} of them across a tile seam)\n` +
      `  ${pct(masked)}% of the wall is masked` +
      `   (${pct(missed)}% bare with a plate available, ${pct(refused)}% bare because the ground refuses one)\n` +
      `  widest bare run ${(gaps[0]?.dia ?? 0).toFixed(0)} m, next ` +
      `${gaps.slice(1, 4).map((g) => g.dia.toFixed(0)).join('/')} m of ${gaps.length}\n` +
      `  ${near.length} plates over ${(wall / 1e4).toFixed(1)} ha of wall -- ${byBed}\n` +
      `  span p10/50/90/max ${at(0.1).toFixed(1)}/${at(0.5).toFixed(1)}/${at(0.9).toFixed(1)}/${at(1).toFixed(1)} m` +
      `   pool ${rocks.beds.filter((b) => CAP_BEDS.includes(b.cfg.name)).reduce((a, b) => a + b.maxInstances, 0)}\n` +
      `  refused ${Object.entries(slabs.rejected).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`
  )
}

// The steepest cells a sweep of the map can find, so the answer is not one
// valley's. The 400th is a 45 degree face, the shallow end of the bed's window.
const out = { h: 0, tan: 0 }
const spots = []
for (let i = 0; i < 4000; i++) {
  const x = ((i * 977) % 8000) - 4000
  const z = ((i * 1613) % 8000) - 4000
  field.scatterAt(x, z, 4, out)
  spots.push({ x, z, tan: out.tan })
}
spots.sort((a, b) => b.tan - a.tan)

for (const s of [spots[0], spots[40], spots[400]]) {
  const rocks = new Rocks(new THREE.Scene(), field, dryWater, layers, texArray, { seed: 7 })
  const t = performance.now()
  rocks.place(s.x, s.z)
  const ms = performance.now() - t
  report(
    rocks,
    s.x,
    s.z,
    `${s.x}, ${s.z} -- a ${((Math.atan(s.tan) * 180) / Math.PI).toFixed(0)} degree face, place ${ms.toFixed(0)} ms`
  )
  rocks.dispose()
}
