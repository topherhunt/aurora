// THROWAWAY. Cost curve for the `scree` bed in src/v2/render/rocks.js.
//
//   node scripts/probe-scree.mjs
//
// Reuses check-rocks.mjs's `ridge` stub world and its spacing metric verbatim
// (scripts/check-rocks.mjs section 8, "the pile itself, in metres"):
//
//   isFoot(x, z) = scree._relief(x, z, ridge.heightAt(x)) === 'foot'
//   footN        = rocks from EVERY bed inside R with isFoot(x, z)
//   footA        = foot ground inside R, sampled on a 2 m lattice, 4 m2 a hit
//   spacing      = sqrt(footA / footN)                     -- 1/sqrt(density)
//
// i.e. the side of the square each rock would own if the foot ground were a
// lattice. NOT nearest-neighbour. The shipped figure quoted in
// design/05-rendering.md ("one rock every 2.5 m") is this number at R = 140.
//
// Everything is averaged over three world seeds, because the foot ground on the
// ridge stub is a set of narrow stripes (6.4% of the disc) and the clump
// lattice has its own 26 m cells: at a high clumpFloor, WHICH cells happen to
// land on a stripe is a realisation artifact worth several tens of per cent.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import * as THREE from 'three'

import { Rocks } from '../src/v2/render/rocks.js'
import { buildTextureArray } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { Layers } from '../src/v2/layers/layers.js'

const SEEDS = [7, 11, 13]

// --- check-rocks.mjs's ridge stub, copied verbatim ---------------------------
const RIDGE_A = 22
const RIDGE_L = 20
const ridge = {
  field: {
    scatterAt: (x, z, cell, out) => {
      if (!(cell > 0)) throw new Error('scatterAt needs a positive cell')
      out.h = 900 + RIDGE_A * Math.sin(x / RIDGE_L)
      out.tan = Math.abs((RIDGE_A / RIDGE_L) * Math.cos(x / RIDGE_L))
      return out
    },
    heightAt: (x) => 900 + RIDGE_A * Math.sin(x / RIDGE_L),
    snowLineAt: () => 880,
    bands: { altLo: 0, altSpan: 900 },
  },
  water: { levelAt: () => null, isSubmerged: () => false },
}
const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }

// Counting wrappers around the stub, so a bed's field traffic can be attributed.
const count = { scatter: 0, height: 0 }
const countingField = {
  ...ridge.field,
  scatterAt: (x, z, cell, out) => { count.scatter++; return ridge.field.scatterAt(x, z, cell, out) },
  heightAt: (x, z) => { count.height++; return ridge.field.heightAt(x, z) },
}

const texArray = buildTextureArray()
const scene = new THREE.Scene()

// One Rocks, built with the SHIPPED constants, for three things: the bank and
// material every swept bed reuses, the three non-scree beds (which the spacing
// metric counts and which no lever here moves), and the RockBed class itself,
// which rocks.js does not export.
const base = new Rocks(scene, countingField, ridge.water, layers, texArray, { seed: 7, seeds: 2 })
const RockBed = Object.getPrototypeOf(base.beds[0]).constructor
const SCREE = base.beds.findIndex((b) => b.cfg.name === 'scree')
const cfg = base.beds[SCREE].cfg
// The bed's index in BEDS, not in the survivors -- it is what seeds the scatter
// field, so a swept bed built with the array position would lay a different world
// than the one that ships. See the `enabled` note in rocks.js.
const SCREE_SEED_INDEX = base.beds[SCREE].index
const SHIPPED = { ...cfg }

const bedCost = []
for (const bed of base.beds) {
  count.scatter = 0
  count.height = 0
  const relief0 = bed._relief.bind(bed)
  let reliefs = 0
  bed._relief = (x, z, h) => { reliefs++; return relief0(x, z, h) }
  bed.place(0, 0)
  bedCost.push({ name: bed.cfg.name, ms: bed.placeMs, scatter: count.scatter, height: count.height, reliefs, rejected: { ...bed.rejected }, samples: bed.samples })
}

// isFoot goes through the UNcounted field, so probing the ground for the area
// integrals cannot pollute a bed's traffic counters.
const relief1 = base.beds[SCREE]._relief.bind(base.beds[SCREE])
base.beds[SCREE].field = ridge.field
const isFoot = (x, z) => relief1(x, z, ridge.field.heightAt(x)) === 'foot'

/** The foot lattice inside R, on check-rocks' own 2 m step: xs, zs, 4 m2 each. */
function footLattice(R) {
  const xs = []
  const zs = []
  for (let x = -R; x <= R; x += 2) {
    for (let z = -R; z <= R; z += 2) if (x * x + z * z <= R * R && isFoot(x, z)) { xs.push(x); zs.push(z) }
  }
  return { xs, zs, area: xs.length * 4 }
}
const FOOT140 = footLattice(140)
const FOOT110 = footLattice(110)
const FOOT90 = footLattice(90)
const FOOT40 = footLattice(40)
const footFor = (R) => (R === 140 ? FOOT140 : R === 110 ? FOOT110 : R === 90 ? FOOT90 : FOOT40)

function footRocks(beds, R) {
  const xs = []
  const zs = []
  const sizes = []
  for (const b of beds) {
    for (const t of b.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        const x = b.instX[id]
        const z = b.instZ[id]
        if (x * x + z * z > R * R || !isFoot(x, z)) continue
        xs.push(x)
        zs.push(z)
        sizes.push(b.shapes[b.shapeAt[id]].measured.width * b.instScale[id])
      }
    }
  }
  return { xs, zs, sizes }
}

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN)

function nearestNeighbours(xs, zs) {
  const out = []
  for (let i = 0; i < xs.length; i++) {
    let best = Infinity
    for (let j = 0; j < xs.length; j++) {
      if (i === j) continue
      const d = (xs[i] - xs[j]) ** 2 + (zs[i] - zs[j]) ** 2
      if (d < best) best = d
    }
    if (best < Infinity) out.push(Math.sqrt(best))
  }
  return out
}

/** Fraction of the given foot lattice with no rock within `r` metres. */
function bareFraction(foot, xs, zs, r) {
  const r2 = r * r
  let bare = 0
  for (let p = 0; p < foot.xs.length; p++) {
    let hit = false
    for (let i = 0; i < xs.length && !hit; i++) {
      if ((xs[i] - foot.xs[p]) ** 2 + (zs[i] - foot.zs[p]) ** 2 <= r2) hit = true
    }
    if (!hit) bare++
  }
  return bare / foot.xs.length
}

const others = base.beds.filter((b) => b.cfg.name !== 'scree')
const OTHER = { 140: footRocks(others, 140), 110: footRocks(others, 110), 90: footRocks(others, 90), 40: footRocks(others, 40) }

/** One scree bed at `over`, on one seed. */
function once(over, seed) {
  Object.assign(cfg, SHIPPED, over)
  const bed = new RockBed(scene, countingField, ridge.water, layers, base.material, base.bank, cfg, SCREE_SEED_INDEX, { seed, ground: null })
  const relief0 = bed._relief.bind(bed)
  let reliefs = 0
  // How many DISTINCT 4 m cells (rocks.js's own PLACEMENT_CELL) the relief probe
  // is asked about -- i.e. what a memo on that grid would cut the probe down to.
  const cells = new Set()
  bed._relief = (x, z, h) => {
    reliefs++
    cells.add(Math.floor(x / 4) * 100000 + Math.floor(z / 4))
    return relief0(x, z, h)
  }
  count.scatter = 0
  count.height = 0
  bed.place(0, 0)
  const scatter = count.scatter
  const height = count.height
  const ms = bed.placeMs

  const R = cfg.radius
  const foot = footFor(R)
  const s = footRocks([bed], R)
  // THE GATE ALWAYS MEASURES AT R = 140, whatever `radius` the bed is set to, so
  // a shorter radius does not make the metric easier -- it just leaves the outer
  // ground empty. Reporting spacing over the bed's own disc (which an earlier
  // draft did) hides that entirely.
  const s140 = R === 140 ? s : footRocks([bed], 140)
  const gateN = OTHER[140].xs.length + s140.xs.length
  const s40 = footRocks([bed], 40)
  // EVERY statistic below is over the gate's fixed R = 140 population, never the
  // bed's own disc, so a shorter `radius` shows up as the emptier ground it is
  // instead of quietly shrinking the area it is scored against.
  const allX = [...OTHER[140].xs, ...s140.xs]
  const allZ = [...OTHER[140].zs, ...s140.zs]
  const all40X = [...OTHER[40].xs, ...s40.xs]
  const all40Z = [...OTHER[40].zs, ...s40.zs]

  // THE PILE'S OWN GROUND: the foot lattice restricted to clump >= clumpFloor,
  // which is the only ground this bed will ever stand on. `spacing` over the
  // whole foot averages the drifts together with the bare swathes the floor
  // exists to create, so it is the wrong number to read "one rock per metre" off
  // once the floor is doing anything.
  let inPileA = 0
  for (let p = 0; p < FOOT140.xs.length; p++) {
    if (bed._clump(FOOT140.xs[p], FOOT140.zs[p]) >= cfg.clumpFloor) inPileA += 4
  }
  // ...and the rocks STANDING on it, so numerator and denominator describe the
  // same ground. Counting every foot rock against the pile area alone (which is
  // what an earlier draft did) flatters the in-pile figure badly.
  let inPileN = 0
  for (let i = 0; i < allX.length; i++) {
    if (bed._clump(allX[i], allZ[i]) >= cfg.clumpFloor) inPileN++
  }

  const out = {
    placed: bed.placed,
    inFull: s40.xs.length,
    footN: allX.length,
    screeN: s140.xs.length,
    footA: FOOT140.area,
    inPileA,
    inPileN,
    gateN,
    gate: Math.sqrt(FOOT140.area / Math.max(1, gateN)),
    spacing: Math.sqrt(foot.area / Math.max(1, OTHER[R].xs.length + s.xs.length)),
    spacingPile: Math.sqrt(inPileA / Math.max(1, inPileN)),
    spacing40: Math.sqrt(FOOT40.area / Math.max(1, all40X.length)),
    ms, scatter, height, reliefs, cells: cells.size,
    samples: bed.samples,
    rejected: { ...bed.rejected },
    sited: { ...bed.sited },
    pool: bed.maxInstances,
    used: bed.maxInstances - bed.freeCount,
    // Everything below is over the WHOLE foot disc, all beds -- the same
    // population the gate's spacing describes. The 124 m2 inside fullRadius is
    // 31 lattice points, too few to say anything about swathes.
    sizes: [...OTHER[140].sizes, ...s140.sizes],
    nn: nearestNeighbours(allX, allZ),
    bare3: bareFraction(FOOT140, allX, allZ, 3),
    bare15: bareFraction(FOOT140, allX, allZ, 1.5),
  }
  bed.dispose()
  scene.remove(bed.batch)
  return out
}

/** `once` over every seed, means for the scalars and pooled for the samples. */
function run(over) {
  const rs = SEEDS.map((s) => once(over, s))
  const mean = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length
  const sizes = rs.flatMap((r) => r.sizes).sort((a, b) => a - b)
  const nn = rs.flatMap((r) => r.nn).sort((a, b) => a - b)
  return {
    over,
    placed: mean((r) => r.placed),
    inFull: mean((r) => r.inFull),
    footN: mean((r) => r.footN),
    screeN: mean((r) => r.screeN),
    gateN: mean((r) => r.gateN),
    gate: mean((r) => r.gate),
    footA: rs[0].footA,
    inPileA: mean((r) => r.inPileA),
    inPileN: mean((r) => r.inPileN),
    spacing: mean((r) => r.spacing),
    spacingPile: mean((r) => r.spacingPile),
    spacing40: mean((r) => r.spacing40),
    ms: mean((r) => r.ms),
    scatter: mean((r) => r.scatter),
    height: mean((r) => r.height),
    reliefs: mean((r) => r.reliefs),
    cells: mean((r) => r.cells),
    samples: mean((r) => r.samples),
    rejected: Object.fromEntries(Object.keys(rs[0].rejected).map((k) => [k, mean((r) => r.rejected[k])])),
    sited: { foot: mean((r) => r.sited.foot) },
    pool: rs[0].pool,
    used: mean((r) => r.used),
    sizes, nn,
    bare3: mean((r) => r.bare3),
    bare15: mean((r) => r.bare15),
    spread: Math.max(...rs.map((r) => r.spacing)) - Math.min(...rs.map((r) => r.spacing)),
  }
}


// --- FINE SWEEP: the cheapest triple that reaches 1 m on the GATE metric ------
//
// `node scripts/probe-scree.mjs fine`. Everything here is measured at R = 140,
// all beds, which is what check-rocks.mjs asserts on -- a bed with radius 110
// is scored over the same 3912 m2 as one with radius 140 and simply leaves the
// ring between them bare.

if (process.argv[2] === 'fine') {
  const tScatter = 900e-9 * 1e3
  const tHeight = 1120e-9 * 1e3
  const realMs = (r) => (r.scatter * tScatter + r.height * tHeight)

  console.log('\n=== fine sweep, scored on the GATE metric (all beds, R = 140, 3912 m2) ===\n')
  console.log(`rocks.js sha1 ${createHash('sha1').update(readFileSync(new URL('../src/v2/render/rocks.js', import.meta.url))).digest('hex').slice(0, 12)}`)
  console.log(`SHIPPED NOW: density ${SHIPPED.density}  clumpFloor ${SHIPPED.clumpFloor}  radius ${SHIPPED.radius}  fullRadius ${SHIPPED.fullRadius}  bands ${SHIPPED.bands.join('/')}\n`)
  console.log('  dens  floor  rad | GATE m  inPile | footN  scree | scatterAt  _relief  real ms | nn p10/med/p90 | bare 3m/1.5m | size p10/med/p90 | pool     used   occ')
  const cases = []
  for (const rad of [110, 140]) for (const d of [2.0, 2.5, 3.0, 3.5]) cases.push([d, 0.42, rad])
  for (const d of [2.5, 3.0, 3.5]) cases.push([d, 0.5, 140])
  for (const d of [2.5, 3.0]) cases.push([d, 0.34, 140])
  for (const [d, f, rad] of cases) {
    const bands = [SHIPPED.bands[0], SHIPPED.bands[1], Math.round((100 / 140) * rad)]
    const r = run({ density: d, clumpFloor: f, radius: rad, bands })
    console.log(
      `  ${d.toFixed(1).padStart(4)}  ${f.toFixed(2)}  ${String(rad).padStart(3)} | ` +
      `${r.gate.toFixed(2).padStart(6)}  ${r.spacingPile.toFixed(2).padStart(6)} | ` +
      `${r.gateN.toFixed(0).padStart(5)}  ${r.screeN.toFixed(0).padStart(5)} | ` +
      `${r.scatter.toFixed(0).padStart(9)}  ${r.reliefs.toFixed(0).padStart(7)}  ${realMs(r).toFixed(0).padStart(7)} | ` +
      `${pct(r.nn, 0.1).toFixed(2)} / ${pct(r.nn, 0.5).toFixed(2)} / ${pct(r.nn, 0.9).toFixed(2)} | ` +
      `${(r.bare3 * 100).toFixed(0).padStart(4)}% ${(r.bare15 * 100).toFixed(0).padStart(4)}% | ` +
      `${pct(r.sizes, 0.1).toFixed(2)} / ${pct(r.sizes, 0.5).toFixed(2)} / ${pct(r.sizes, 0.9).toFixed(2)} | ` +
      `${String(r.pool).padStart(6)} ${r.used.toFixed(0).padStart(6)}  ${((r.used / r.pool) * 100).toFixed(1)}%`
    )
  }
  // What a Poisson sprinkle of the SAME average density would look like, which
  // is the only way to say "bunched" rather than "dense" with a number.
  console.log('\n  poisson reference at the same average spacing (what an even sprinkle would give):')
  console.log('    spacing m | nn p10/med/p90 m        | bare 3 m   bare 1.5 m')
  for (const sp of [1.0, 1.2, 1.5, 2.0]) {
    const lam = 1 / (sp * sp)
    const q = (p) => Math.sqrt(-Math.log(1 - p) / (Math.PI * lam))
    const bare = (rr) => Math.exp(-lam * Math.PI * rr * rr)
    console.log(`    ${sp.toFixed(2).padStart(9)} | ${q(0.1).toFixed(2)} / ${q(0.5).toFixed(2)} / ${q(0.9).toFixed(2)}       | ${(bare(3) * 100).toFixed(1).padStart(6)}%  ${(bare(1.5) * 100).toFixed(1).padStart(8)}%`)
  }
  Object.assign(cfg, SHIPPED)
  process.exit(0)
}

// --- step 2: the shipped constants -------------------------------------------

console.log('\n=== scree probe ===\n')
console.log(`ridge stub (check-rocks.mjs), seeds ${SEEDS.join(',')}, bank ${base.bank.shapes.length} shapes, build ${base.buildMs.toFixed(0)} ms`)
console.log(`rocks.js sha1 ${createHash('sha1').update(readFileSync(new URL('../src/v2/render/rocks.js', import.meta.url))).digest('hex').slice(0, 12)}, beds: ${base.beds.map((b) => b.cfg.name).join(', ')}`)
console.log(`foot ground: ${FOOT140.area} m2 inside R=140 (6.4% of the disc), ${FOOT40.area} m2 inside R=40 = fullRadius\n`)

console.log('placement cost by bed, shipped constants, seed 7 (stub field -- real-field model at the end):')
for (const b of bedCost) {
  console.log(`  ${b.name.padEnd(10)} ${b.ms.toFixed(1).padStart(6)} ms   scatterAt ${String(b.scatter).padStart(6)}   heightAt ${String(b.height).padStart(7)}   _relief ${String(b.reliefs).padStart(6)}`)
}

const shipped = run({ density: SHIPPED.density, clumpFloor: SHIPPED.clumpFloor })
const q5 = (a) => `${pct(a, 0).toFixed(2)} / ${pct(a, 0.1).toFixed(2)} / ${pct(a, 0.5).toFixed(2)} / ${pct(a, 0.9).toFixed(2)} / ${pct(a, 1 - 1e-9).toFixed(2)}`
console.log(`\nSHIPPED  density ${SHIPPED.density}  clumpFloor ${SHIPPED.clumpFloor}  fullRadius ${SHIPPED.fullRadius}  radius ${SHIPPED.radius}  tile ${SHIPPED.tile}  scale ${SHIPPED.scale.join('-')}`)
console.log(`  placed          ${shipped.placed.toFixed(0)} over the 140 m disc; ${shipped.inFull.toFixed(0)} inside fullRadius=40`)
console.log(`  spacing         ${shipped.spacing.toFixed(2)} m  harness metric, all beds, R=140  (+/-${shipped.spread.toFixed(2)} across seeds)`)
console.log(`                  ${shipped.spacingPile.toFixed(2)} m  over the ${shipped.inPileA.toFixed(0)} m2 that clears clumpFloor (${((shipped.inPileA / shipped.footA) * 100).toFixed(0)}% of the foot)`)
console.log(`                  ${shipped.spacing40.toFixed(2)} m  all beds, inside fullRadius`)
console.log(`  samples         ${shipped.samples.toFixed(0)}   rejected ${Object.entries(shipped.rejected).map(([k, v]) => `${k} ${v.toFixed(0)}`).join('  ')}`)
console.log(`  sited foot      ${shipped.sited.foot.toFixed(0)}`)
console.log(`  cost            ${shipped.ms.toFixed(1)} ms stub   scatterAt ${shipped.scatter.toFixed(0)}   _relief ${shipped.reliefs.toFixed(0)}   heightAt ${shipped.height.toFixed(0)}`)
console.log(`  pool            ${shipped.pool}, ${shipped.used.toFixed(0)} used (${((shipped.used / shipped.pool) * 100).toFixed(1)}%)`)
console.log(`  size m          min/p10/med/p90/max = ${q5(shipped.sizes)}   (n=${shipped.sizes.length}, all foot rocks inside R=140)`)
console.log(`  nn m            ${q5(shipped.nn)}`)
console.log(`  bare            ${(shipped.bare3 * 100).toFixed(0)}% of foot ground has no rock within 3 m, ${(shipped.bare15 * 100).toFixed(0)}% within 1.5 m`)

// --- step 3: the sweep --------------------------------------------------------

const DENS = [0.3, 0.6, 1.0, 1.5, 2.0, 2.5, 3.0]
const FLOORS = [0.42, 0.5, 0.58, 0.65]

console.log('\n=== sweep: density x clumpFloor  (fullRadius 40, radius 140) ===\n')
console.log('  dens  floor | spacing  inPile  @full | footN  scree | stub ms  scatterAt  _relief  clumpRej  siteRej | pool     used')
const grid = []
for (const d of DENS) {
  for (const f of FLOORS) {
    const r = run({ density: d, clumpFloor: f })
    grid.push(r)
    console.log(
      `  ${d.toFixed(1).padStart(4)}  ${f.toFixed(2)} | ` +
      `${r.spacing.toFixed(2).padStart(6)}  ${r.spacingPile.toFixed(2).padStart(6)}  ${r.spacing40.toFixed(2).padStart(5)} | ` +
      `${r.footN.toFixed(0).padStart(5)}  ${r.screeN.toFixed(0).padStart(5)} | ${r.ms.toFixed(1).padStart(7)}  ${r.scatter.toFixed(0).padStart(9)}  ${r.reliefs.toFixed(0).padStart(7)}  ` +
      `${r.rejected.clump.toFixed(0).padStart(8)}  ${r.rejected.site.toFixed(0).padStart(7)} | ${String(r.pool).padStart(6)} ${r.used.toFixed(0).padStart(7)}`
    )
  }
}

// --- step 4: how clumped ------------------------------------------------------

console.log('\n=== the pile: nearest-neighbour and bare ground (ALL foot ground inside R=140, all beds, 3 seeds pooled) ===\n')
console.log('  dens  floor | spacing  inPile | nn p10/med/p90 m  | no rock w/in 3 m  1.5 m | size p10/med/p90 m')
for (const r of grid) {
  console.log(
    `  ${r.over.density.toFixed(1).padStart(4)}  ${r.over.clumpFloor.toFixed(2)} | ${r.spacing.toFixed(2).padStart(6)}  ${r.spacingPile.toFixed(2).padStart(6)} | ` +
    `${pct(r.nn, 0.1).toFixed(2)} / ${pct(r.nn, 0.5).toFixed(2)} / ${pct(r.nn, 0.9).toFixed(2)}  | ` +
    `${(r.bare3 * 100).toFixed(0).padStart(14)}%  ${(r.bare15 * 100).toFixed(0).padStart(4)}% | ` +
    `${pct(r.sizes, 0.1).toFixed(2)} / ${pct(r.sizes, 0.5).toFixed(2)} / ${pct(r.sizes, 0.9).toFixed(2)}`
  )
}

// --- step 4b: the pile's SHAPE, on ground with no thinning on it -------------
//
// The block above measures nearest-neighbour and bare ground on the foot inside
// fullRadius, which is 124 m2 and 31 lattice points -- too few to say anything
// about swathes, and dominated by the other four beds, which stand everywhere.
// So: one pass with fullRadius = radius = 140, which turns the graded thinning
// off entirely and puts the whole 3912 m2 foot lattice at full density. This is
// the geometry question only; the cost of these runs is not a shipping cost.

console.log('\n=== the pile\'s shape, thinning OFF (fullRadius = radius = 140), 978 foot lattice points ===\n')
console.log('  dens  floor | pile ground | scree spacing  in-pile | nn p10/med/p90 | no scree within 1.5 / 3 / 5 m')
for (const [d, f] of [[0.3, 0.42], [0.6, 0.42], [0.6, 0.58], [1.0, 0.5], [1.0, 0.58], [1.0, 0.65], [1.5, 0.58], [1.5, 0.65]]) {
  const rs = SEEDS.map((seed) => {
    Object.assign(cfg, SHIPPED, { density: d, clumpFloor: f, fullRadius: 140, radius: 140 })
    const bed = new RockBed(scene, countingField, ridge.water, layers, base.material, base.bank, cfg, SCREE_SEED_INDEX, { seed, ground: null })
    bed.place(0, 0)
    const s = footRocks([bed], 140)
    let pileA = 0
    for (let p = 0; p < FOOT140.xs.length; p++) if (bed._clump(FOOT140.xs[p], FOOT140.zs[p]) >= f) pileA += 4
    const out = {
      n: s.xs.length,
      pileA,
      nn: nearestNeighbours(s.xs, s.zs),
      bare: [1.5, 3, 5].map((r) => bareFraction(FOOT140, s.xs, s.zs, r)),
    }
    bed.dispose()
    scene.remove(bed.batch)
    return out
  })
  const mean = (g) => rs.reduce((a, r) => a + g(r), 0) / rs.length
  const nn = rs.flatMap((r) => r.nn).sort((a, b) => a - b)
  const n = mean((r) => r.n)
  const pileA = mean((r) => r.pileA)
  console.log(
    `  ${d.toFixed(1).padStart(4)}  ${f.toFixed(2)} | ${((pileA / FOOT140.area) * 100).toFixed(0).padStart(9)}% | ` +
    `${Math.sqrt(FOOT140.area / n).toFixed(2).padStart(13)}  ${Math.sqrt(pileA / n).toFixed(2).padStart(7)} | ` +
    `${pct(nn, 0.1).toFixed(2)} / ${pct(nn, 0.5).toFixed(2)} / ${pct(nn, 0.9).toFixed(2)} | ` +
    `${[0, 1, 2].map((i) => `${(mean((r) => r.bare[i]) * 100).toFixed(0)}%`.padStart(4)).join(' / ')}`
  )
}

// --- step 3b: radius ----------------------------------------------------------

const reached = grid.filter((r) => r.spacing <= 1.02)
const pick = reached.length
  ? reached.reduce((a, b) => (a.scatter <= b.scatter ? a : b))
  : grid.reduce((a, b) => (a.spacing <= b.spacing ? a : b))
console.log(`\n=== radius, at density ${pick.over.density} / clumpFloor ${pick.over.clumpFloor} ` +
  `(${reached.length ? 'cheapest pair reaching ~1.0 m' : 'nothing reached 1.0 m -- densest pair'}) ===\n`)
console.log('  radius | spacing(own R)  @full | placed  stub ms  scatterAt  _relief | pool     used')
for (const R of [140, 110, 90]) {
  // BANDS ARE ABSOLUTE METRES and RockBed only checks their COUNT, so a shorter
  // radius with the shipped [18, 55, 100] would put the card boundary outside
  // the bed. Scale it by the same fraction of radius it holds at 140.
  const bands = [SHIPPED.bands[0], SHIPPED.bands[1], Math.round((SHIPPED.bands[2] / SHIPPED.radius) * R)]
  const r = run({ density: pick.over.density, clumpFloor: pick.over.clumpFloor, radius: R, bands })
  console.log(
    `  ${String(R).padStart(6)} | ${r.spacing.toFixed(2).padStart(13)}  ${r.spacing40.toFixed(2).padStart(5)} | ` +
    `${r.placed.toFixed(0).padStart(6)}  ${r.ms.toFixed(1).padStart(7)}  ${r.scatter.toFixed(0).padStart(9)}  ${r.reliefs.toFixed(0).padStart(7)} | ${String(r.pool).padStart(6)} ${r.used.toFixed(0).padStart(7)}`
  )
}

// --- fullRadius, which is the lever that buys the NEAR field only -------------

console.log('\n=== fullRadius, at density 0.6 / clumpFloor 0.42 (radius 140) ===\n')
console.log('  fullR | spacing  @full | placed  stub ms  scatterAt  _relief | pool     used')
for (const F of [40, 55, 70, 90]) {
  const r = run({ density: 0.6, clumpFloor: 0.42, fullRadius: F })
  console.log(
    `  ${String(F).padStart(5)} | ${r.spacing.toFixed(2).padStart(6)}  ${r.spacing40.toFixed(2).padStart(5)} | ` +
    `${r.placed.toFixed(0).padStart(6)}  ${r.ms.toFixed(1).padStart(7)}  ${r.scatter.toFixed(0).padStart(9)}  ${r.reliefs.toFixed(0).padStart(7)} | ${String(r.pool).padStart(6)} ${r.used.toFixed(0).padStart(7)}`
  )
}

// --- step 5: the pool alone ---------------------------------------------------

console.log('\n=== _poolBound() by density (radius 140, tile 14, fullRadius 40) ===\n')
for (const r of grid.filter((g) => g.over.clumpFloor === 0.42)) {
  console.log(`  density ${r.over.density.toFixed(1)}  maxInstances ${String(r.pool).padStart(6)}  peak used ${r.used.toFixed(0).padStart(6)}  (${((r.used / r.pool) * 100).toFixed(1)}% of pool)`)
}
console.log('  (`used` is what the whole 140 m disc held at once; the pool never came close to running dry)')

// --- the real field, so the stub's wall-clock can be converted -----------------

console.log('\n=== real-field cost per query, for converting the stub milliseconds ===\n')
{
  const hm = await Heightmap.read({
    path: new URL('../public/world/height.png', import.meta.url),
    metaPath: new URL('../public/world/height.json', import.meta.url),
  })
  const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED })
  const out = { h: 0, tan: 0 }
  const N = 60000
  for (let i = 0; i < 8000; i++) { field.scatterAt(i * 3.1, i * 1.7, 4, out); field.heightAt(i * 3.1, i * 1.7) }
  let t = performance.now()
  for (let i = 0; i < N; i++) field.scatterAt(i * 3.13, i * 1.71, 4, out)
  const tScatter = ((performance.now() - t) * 1e6) / N
  t = performance.now()
  for (let i = 0; i < N; i++) field.heightAt(i * 3.13, i * 1.71)
  const tHeight = ((performance.now() - t) * 1e6) / N
  console.log(`  scatterAt ${tScatter.toFixed(0)} ns   heightAt ${tHeight.toFixed(0)} ns   -> one _relief probe = 4 heightAt = ${(4 * tHeight).toFixed(0)} ns`)

  const model = (r) => (r.scatter * tScatter + r.height * tHeight) / 1e6
  console.log(`\n  modelled full-disc placement on the REAL field:\n`)
  console.log('    dens  floor | spacing  inPile | real ms   us/rock')
  console.log(`    ship  ${SHIPPED.clumpFloor.toFixed(2)} | ${shipped.spacing.toFixed(2).padStart(6)}  ${shipped.spacingPile.toFixed(2).padStart(6)} | ${model(shipped).toFixed(1).padStart(6)}   ${((model(shipped) * 1000) / shipped.placed).toFixed(0).padStart(6)}`)
  for (const r of grid) {
    console.log(`    ${r.over.density.toFixed(1).padStart(4)}  ${r.over.clumpFloor.toFixed(2)} | ${r.spacing.toFixed(2).padStart(6)}  ${r.spacingPile.toFixed(2).padStart(6)} | ${model(r).toFixed(1).padStart(6)}   ${((model(r) * 1000) / r.placed).toFixed(0).padStart(6)}`)
  }
  console.log(`\n  the other three beds, for scale: ${bedCost.filter((b) => b.name !== 'scree').map((b) => `${b.name} ${((b.scatter * tScatter + b.height * tHeight) / 1e6).toFixed(1)} ms`).join(', ')}`)

  // WHERE THE MONEY ACTUALLY GOES. rocks.js's comments say the terrain sample
  // dominates placement; on this bed it does not, because `footOnly` makes
  // _relief a per-candidate cost too and _relief is four heightAt.
  console.log('\n  cost split, and what a _relief memo on the 4 m PLACEMENT_CELL grid would leave:\n')
  console.log('    dens  floor | scatterAt  _relief  per-placed | real ms | distinct 4 m cells  memo ms  memo us/rock')
  for (const r of [shipped, ...grid]) {
    const cScatter = (r.scatter * tScatter) / 1e6
    const cRelief = (r.reliefs * 4 * tHeight) / 1e6
    const cPlaced = (r.placed * 5 * tHeight) / 1e6
    const memo = cScatter + (r.cells * 4 * tHeight) / 1e6 + cPlaced
    console.log(
      `    ${r.over.density.toFixed(1).padStart(4)}  ${r.over.clumpFloor.toFixed(2)} | ` +
      `${cScatter.toFixed(1).padStart(9)}  ${cRelief.toFixed(1).padStart(7)}  ${cPlaced.toFixed(1).padStart(10)} | ` +
      `${(cScatter + cRelief + cPlaced).toFixed(1).padStart(7)} | ${r.cells.toFixed(0).padStart(18)}  ${memo.toFixed(1).padStart(7)}  ${((memo * 1000) / r.placed).toFixed(0).padStart(12)}`
    )
  }
}

// --- does clumpFloor really refund? eight seeds on two floors ----------------
//
// The three-seed sweep shows cost per rock RISING with the floor, which would
// mean the floor does not refund what it removes. That reading is suspect: the
// foot ground is stripes and the clump lattice is 26 m cells, so on any one seed
// the mask and the stripes correlate by luck. Eight seeds, two floors.

console.log('\n=== does clumpFloor refund? density 0.3, eight seeds ===\n')
{
  const many = [7, 11, 13, 17, 23, 29, 31, 37]
  console.log('  floor | placed  scatterAt  candidates/rock  spacing (mean, min..max)')
  for (const f of [0.42, 0.5, 0.58, 0.65]) {
    const rs = many.map((s) => once({ density: 0.3, clumpFloor: f }, s))
    const placed = rs.reduce((a, r) => a + r.placed, 0) / rs.length
    const scatter = rs.reduce((a, r) => a + r.scatter, 0) / rs.length
    const sp = rs.map((r) => r.spacing)
    console.log(`  ${f.toFixed(2)}  | ${placed.toFixed(0).padStart(6)}  ${scatter.toFixed(0).padStart(9)}  ${(scatter / placed).toFixed(1).padStart(15)}  ` +
      `${(sp.reduce((a, b) => a + b, 0) / sp.length).toFixed(2)}  (${Math.min(...sp).toFixed(2)}..${Math.max(...sp).toFixed(2)})`)
  }
}

Object.assign(cfg, SHIPPED)
console.log('')
