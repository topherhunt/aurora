// Node-side gate for src/v2/terrain/quadtree-v2.js -- the LOD selector for the deep tree v2 needs (DESIGN.md §18). Three-free on both sides, so this runs headless and needs no browser, no GPU and no worker.
//
//   node scripts/check-v2-quadtree.mjs
//
// scripts/check-v2.mjs owns the combined run and imports run() from here.
//
// WHY THIS CAN BE GATED BEFORE THE v2 HEIGHT FIELD EXISTS. The split rule is
//
//     split while  cell > range * tan(triDeg)
//
// and NOTHING in it reads the height field. `range` reads a node's vertical bounds, which the mesher reports and selection merely consumes; the field could be a photograph of the Alps or a plane and the descent would be the same shape. So this gate supplies its own analytic stand-in for those bounds -- a couple of sines, ~600 m of relief -- and every claim below is a claim about the selector, not about the terrain. When src/v2/height/field.js lands, the thing to re-measure with the real field is the DRAWN triangle counts (which depend on where the ground is relative to the eye) and the angular-inversion percentage; the slot-pool ladder and the tiling invariants will not move.
//
// Sweep construction, the eye cone and the counting are deliberately identical to scripts/check-sim.mjs section 5 and scripts/probe-lod.mjs section 3, so the v2 numbers can be read directly against v1's.

import {
  LOD,
  MIN_TRI_DEG,
  MAX_TRI_DEG,
  VIEW_HALF_ANGLE,
  EYE_HALF_ANGLE,
  nodeKey,
  parentKey,
  unpackKey,
  nodeRange,
  inCone,
  selectNodes,
} from '../src/v2/terrain/quadtree-v2.js'
import {
  WORLD_SIZE,
  WORLD_HALF,
  CHUNK_RES,
  CHUNK_INDICES,
  MAX_DEPTH,
  SLOT_COUNT,
  PINNED_CHUNKS,
} from '../src/v2/config.js'
import { TRI_BUDGET } from '../src/budget.js'

const DEG = 180 / Math.PI
const TRIS_PER_CHUNK = CHUNK_INDICES / 3

// --- the analytic stand-in --------------------------------------------------
//
// Three sines, +-320 m about zero so ~640 m of relief across the box, continuous everywhere and cheap enough that a 2400-selection sweep can afford to bound every node it touches. It is NOT v2's field and does not pretend to be: it exists to give nodeRange() a plausible minY/maxY so the 3D range term is exercised rather than falling back to the horizontal distance. See the header for why that is sufficient.
//
// The two long wavelengths are written as fractions of the world box so this stays three or four ridges across the map if WORLD_SIZE moves again -- it already moved twice mid-write, 16384 to 4096 to 8192. The short one is absolute: it is standing in for metre-scale roughness, which does not care how big the world is.
const L1 = WORLD_SIZE / 2.8
const L2 = WORLD_SIZE / 15
const groundAt = (x, z) =>
  200 * Math.sin(x / L1) * Math.cos(z / (L1 * 0.78)) +
  100 * Math.sin(x / L2 + z / (L2 * 1.31)) +
  20 * Math.sin(x / 33 + z / 29)

// A node's vertical extent, sampled on a 3x3 over its box. Under-estimates the true extent slightly, which makes the node look CLOSER than it is and so over-refines: the conservative direction, the same one selection takes when bounds are missing entirely.
function nodeBounds(key) {
  const { depth, ix, iz } = unpackKey(key)
  const size = WORLD_SIZE / (1 << depth)
  const x0 = -WORLD_HALF + ix * size
  const z0 = -WORLD_HALF + iz * size
  let minY = Infinity
  let maxY = -Infinity
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const h = groundAt(x0 + (i / 2) * size, z0 + (j / 2) * size)
      if (h < minY) minY = h
      if (h > maxY) maxY = h
    }
  }
  return { minY, maxY }
}

// Lazily-populated bounds table, shaped like the Map terrain-v2.js will hold.
//
// This is the SETTLED answer in one pass. scripts/lod-sim.mjs iterates select-mesh-select until the selection stops moving, because the real mesher only learns a node's bounds by building it. A node's extent is a property of the world and not of the camera, so the fixed point that iteration converges to is exactly "every node tested knows its own bounds" -- which is what a lazy provider gives directly. Same answer, one pass, and shared across the whole sweep because the world does not move.
const boundsCache = new Map()
const info = {
  get(key) {
    let b = boundsCache.get(key)
    if (b === undefined) {
      b = nodeBounds(key)
      boundsCache.set(key, b)
    }
    return b
  },
}

// --- the sweep --------------------------------------------------------------
//
// 606 positions x 4 headings = 2424 selections, half of them airborne, from the same deterministic LCG and the same construction check-sim.mjs section 5 uses. Airborne is not a detail: the range test is 3D, so a camera 400 m up is genuinely further from the ground below it than its map position says, and that is where a range rule falls apart if it is going to.
//
// Positions are stated as FRACTIONS of WORLD_HALF rather than as metres, because the metres form of this sweep quietly stopped testing anything the first time the world shrank: v1's hard-coded +-8000 m puts every camera outside a smaller box, and a camera outside the box selects one coarse leaf and passes every count it is asked about. That is design/lessons.md's first entry -- an instrument still reporting a number after the thing it measured moved -- and the box has since moved twice more, which the fractions absorbed silently.
const CAMS = []
{
  const f = [
    [0, 0],
    [0.017, -0.514],
    [-0.25, 0.11],
    [0.5, 0.5],
    [-0.854, 0.015],
    [0.075, -0.041],
  ]
  let rs = 12345
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 600; i++) f.push([(rnd() * 2 - 1) * 0.977, (rnd() * 2 - 1) * 0.977])
  for (let i = 0; i < f.length; i++) {
    const x = f[i][0] * WORLD_HALF
    const z = f[i][1] * WORLD_HALF
    // Half on foot, half airborne. The airborne band is absolute metres because the stand-in's 640 m of relief is absolute too, so 150-534 m AGL is "flying over the ridges" for either world size.
    const agl = i % 2 === 0 ? 1.65 : 150 + (i % 7) * 64
    const y = groundAt(x, z) + agl
    for (let q = 0; q < 4; q++) CAMS.push({ x, y, z, yaw: (q * Math.PI) / 2, agl })
  }
}

const pct = (a, p) => {
  const s = Float64Array.from(a).sort()
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

// Worst case over the whole sweep at one cap. `worst` is the SLOT question -- the selection is exempt from eviction in terrain-v2.js, so the maximum has to fit, not the mean. `drawn` is the BUDGET question and is counted against the 110 deg eye cone, not the 180 deg streaming cone: BatchedMesh culls the rest per instance, and conflating the two overstates terrain's share of the frame by about 70%.
function worstAt(triDeg, opts = {}) {
  let worst = 0
  let drawn = 0
  let at = null
  const times = []
  for (const cam of CAMS) {
    const o = { triDeg, info, ...opts }
    // Warm the bounds cache first, then time the second call. The timed call is then measuring selection against a populated Map, which is what the renderer does every 83 ms -- not the cost of this file's stand-in field.
    const warm = selectNodes(cam, o)
    const t0 = performance.now()
    const sel = selectNodes(cam, o)
    times.push(performance.now() - t0)
    if (sel.length !== warm.length) throw new Error('selection moved between identical calls')
    if (sel.length > worst) {
      worst = sel.length
      at = `${cam.x.toFixed(0)},${cam.z.toFixed(0)} at ${cam.agl.toFixed(0)}m AGL yaw ${(cam.yaw * DEG).toFixed(0)}`
    }
    let d = 0
    for (const n of sel) if (inCone(cam, n.x, n.z, n.size, EYE_HALF_ANGLE)) d++
    if (d > drawn) drawn = d
  }
  return { worst, drawn, at, times, tris: drawn * TRIS_PER_CHUNK }
}

export async function run() {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log(`\n=== v2 quadtree checks ===`)
  console.log(
    `    world ${WORLD_SIZE}m  res ${CHUNK_RES}  depth ${MAX_DEPTH} (${WORLD_SIZE / 2 ** MAX_DEPTH}m leaf, ` +
      `${(WORLD_SIZE / 2 ** MAX_DEPTH / CHUNK_RES).toFixed(4)}m cell)  pool ${SLOT_COUNT} + ${PINNED_CHUNKS} pinned  ` +
      `${TRIS_PER_CHUNK} tris/chunk\n`
  )

  // --- 1. key packing -------------------------------------------------------
  //
  // The packing is the one change here that could corrupt the slot pool rather than merely look wrong: two nodes colliding on a key means one slot with two owners. So it is proved rather than spot-checked -- exhaustive round-trip where exhaustive is affordable, plus the band-disjointness that turns the sampled part into an argument instead of a hope.

  console.log('key packing')
  {
    const k = nodeKey(7, 100, 33)
    check(typeof k === 'number', 'nodeKey returns a Number, not a string', `${typeof k} ${k}`)
    check(Number.isInteger(k) && Number.isSafeInteger(k), 'keys are exact safe integers', `${k}`)

    // `seen` maps key -> the triple that produced it. A collision is the same key from a DIFFERENT triple; the same triple twice is just the sample repeating itself and must not be counted, which is a trap the first version of this check fell straight into (23395 "collisions", every one of them a duplicate draw from the random sampler).
    const seen = new Map()
    let bad = 0
    let collide = 0
    let n = 0
    const record = (d, ix, iz) => {
      const key = nodeKey(d, ix, iz)
      const u = unpackKey(key)
      if (u.depth !== d || u.ix !== ix || u.iz !== iz) bad++
      const prev = seen.get(key)
      if (prev === undefined) seen.set(key, `${d}|${ix}|${iz}`)
      else if (prev !== `${d}|${ix}|${iz}`) collide++
      n++
    }

    // Exhaustive over depths 0..8: 87381 triples, every one round-tripped and every one checked for collision against every other.
    for (let d = 0; d <= 8; d++) {
      const span = 1 << d
      for (let iz = 0; iz < span; iz++) for (let ix = 0; ix < span; ix++) record(d, ix, iz)
    }
    check(bad === 0 && n === 87381, `round-trip exhaustive over depths 0..8`, `${n} triples, ${bad} bad`)
    check(collide === 0, 'no collisions among all depth 0..8 keys', `${collide}`)

    // The deep levels are tens of millions of triples; sample the corners, the edges and a large deterministic interior sample instead. The completeness argument for what the sample cannot reach is the band-disjointness check below.
    let rs = 777
    const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    bad = 0
    collide = 0
    const n0 = n
    for (let d = 9; d <= MAX_DEPTH; d++) {
      const span = 1 << d
      const idx = [0, 1, 2, (span >> 1) - 1, span >> 1, span - 2, span - 1]
      for (let i = 0; i < 4000; i++) idx.push(Math.floor(rnd() * span))
      for (const ix of idx) {
        for (const iz of [0, span - 1, Math.floor(rnd() * span), Math.floor(rnd() * span)]) record(d, ix, iz)
      }
    }
    check(bad === 0, `round-trip over depths 9..${MAX_DEPTH} (corners, edges, sampled interior)`, `${n - n0} triples, ${bad} bad`)
    check(collide === 0, `no collisions across the sampled depth 9..${MAX_DEPTH} keys`, `${collide} of ${n - n0}`)

    // The completeness argument the sample cannot give: at depth d both indices are < 2**d <= 2**14, so iz * 2**14 + ix < 2**28 and depth bands cannot reach into each other. Within a band ix < 2**14 makes iz*2**14+ix injective. Together those two facts are the whole proof.
    let overlap = 0
    for (let d = 0; d <= MAX_DEPTH; d++) {
      const span = 1 << d
      const hi = nodeKey(d, span - 1, span - 1)
      if (hi >= (d + 1) * 2 ** 28) overlap++
      if (d > 0 && hi <= nodeKey(d - 1, 0, 0)) overlap++
    }
    check(overlap === 0, 'depth bands are disjoint at every depth (injective by construction)', `${overlap} overlaps`)

    // parentKey is the same packing, not a second one.
    let pbad = 0
    for (let d = 1; d <= MAX_DEPTH; d++) {
      const span = 1 << d
      for (let i = 0; i < 500; i++) {
        const ix = Math.floor(rnd() * span)
        const iz = Math.floor(rnd() * span)
        if (parentKey(d, ix, iz) !== nodeKey(d - 1, ix >> 1, iz >> 1)) pbad++
      }
    }
    check(pbad === 0, 'parentKey(d,ix,iz) === nodeKey(d-1, ix>>1, iz>>1)', `${pbad} bad of 7000`)
    check(parentKey(0, 0, 0) === null, 'parentKey is null at the root', `${parentKey(0, 0, 0)}`)

    // The bounds check must actually throw. A key that silently aliases is the failure this whole section exists to make impossible.
    const throws = (fn) => {
      try {
        fn()
        return false
      } catch {
        return true
      }
    }
    check(
      throws(() => nodeKey(3, 8, 0)) &&
        throws(() => nodeKey(3, 0, -1)) &&
        throws(() => nodeKey(MAX_DEPTH + 1, 0, 0)) &&
        throws(() => nodeKey(MAX_DEPTH, 1 << MAX_DEPTH, 0)),
      'nodeKey THROWS on an out-of-range triple rather than aliasing'
    )
    check(
      throws(() => unpackKey(-1)) && throws(() => unpackKey(1.5)) && throws(() => unpackKey(15 * 2 ** 28)),
      'unpackKey THROWS on a value that is not a node key'
    )
  }

  // --- 2. the selection is a quadtree -------------------------------------
  //
  // "A set of leaves" is only meaningful if it is the leaf set of a real quadtree: no node is an ancestor of another (no overlaps) and the areas add up to the world (no holes). Either failure is a visible hole or a z-fighting double-draw, and neither is visible in a leaf COUNT, which is all the v1 gate checked.

  console.log('\nselection is a valid quadtree leaf set')
  {
    const at = (fx, fz, agl, yaw) => {
      const x = fx * WORLD_HALF
      const z = fz * WORLD_HALF
      return yaw === undefined
        ? { x, y: groundAt(x, z) + agl, z } // no yaw: culling off
        : { x, y: groundAt(x, z) + agl, z, yaw }
    }
    const probes = [
      at(0, 0, 1.65, 0.4),
      at(0.15, -0.73, 300, 2.9),
      at(-0.9999, 0.9999, 1.65, -1.1),
      at(0.0625, 0.0625, 1.65),
    ]
    let overlaps = 0
    let dupes = 0
    let areaBad = 0
    let posBad = 0
    for (const cam of probes) {
      const sel = selectNodes(cam, { info })
      const keys = new Set(sel.map((n) => n.key))
      if (keys.size !== sel.length) dupes++
      let area = 0
      for (const n of sel) {
        area += n.size * n.size
        // Walk to the root; if any ancestor is also in the set the two overlap.
        let d = n.depth
        let ix = n.ix
        let iz = n.iz
        while (d > 0) {
          ix >>= 1
          iz >>= 1
          d--
          if (keys.has(nodeKey(d, ix, iz))) overlaps++
        }
        const size = WORLD_SIZE / (1 << n.depth)
        if (n.size !== size) posBad++
        if (n.x !== -WORLD_HALF + n.ix * size || n.z !== -WORLD_HALF + n.iz * size) posBad++
        if (unpackKey(n.key).depth !== n.depth) posBad++
      }
      if (area !== WORLD_SIZE * WORLD_SIZE) areaBad++
    }
    check(dupes === 0, 'no key appears twice in one selection', `${dupes} of ${probes.length} selections`)
    check(overlaps === 0, 'no selected node is an ancestor of another (no overlap)', `${overlaps}`)
    check(
      areaBad === 0,
      `selected leaves exactly tile the world box (sum of areas === ${WORLD_SIZE}^2)`,
      `${areaBad} of ${probes.length} selections wrong`
    )
    check(posBad === 0, 'each node reports the x/z/size its (depth,ix,iz) implies', `${posBad}`)

    // Determinism. Selection is pure -- no cache, no history, no RNG -- and the streamer relies on that: a node that changed its mind between frames would thrash a slot every time it did.
    const a = selectNodes(probes[1], { info })
    const b = selectNodes(probes[1], { info })
    const same =
      a.length === b.length && a.every((n, i) => n.key === b[i].key && n.x === b[i].x && n.size === b[i].size)
    check(same, 'same camera gives byte-identical selection', `${a.length} leaves`)

    // nodeRange is the thing the whole rule is written in terms of, so its two documented behaviours get an assertion each rather than being trusted.
    const bare = nodeRange({ x: 0, z: 0 }, 100, 0, 50, null)
    const with3d = nodeRange({ x: 0, y: 0, z: 0 }, 100, 0, 50, { minY: 300, maxY: 400 })
    check(bare === 100, 'nodeRange falls back to horizontal distance without bounds', `${bare}`)
    check(
      Math.abs(with3d - Math.hypot(100, 300)) < 1e-9 && with3d > bare,
      'the 3D term makes a node further away, never nearer',
      `${with3d.toFixed(1)} vs ${bare.toFixed(1)}`
    )
  }

  // --- 3. the MAX_TRI_DEG ceiling -----------------------------------------
  //
  // Range is floored at a node's own half-size, so for ANY node containing the camera cell/range = (size/CHUNK_RES)/(size/2) = 2/CHUNK_RES = 0.125, independent of size. atan(0.125) = 7.125 deg is therefore not a tuning threshold but a cliff: one side of it every such node splits, the other side none of them do and the entire world draws as one chunk with WORLD_SIZE/16 triangles. v1 asserts this at MAX_DEPTH 10; the depth changed, so it is MEASURED here rather than inherited.

  console.log('\nMAX_TRI_DEG ceiling')
  {
    const cliff = Math.atan(2 / CHUNK_RES) * DEG
    const cx = 0.299 * WORLD_HALF
    const cz = -0.163 * WORLD_HALF
    const cam = { x: cx, y: groundAt(cx, cz) + 1.65, z: cz, yaw: 0.7 }
    const below = selectNodes(cam, { triDeg: MAX_TRI_DEG, info }).length
    const above = selectNodes(cam, { triDeg: 7.2, info }).length
    console.log(`        atan(2/${CHUNK_RES}) = ${cliff.toFixed(3)} deg   ${MAX_TRI_DEG} -> ${below} leaves   7.2 -> ${above} leaves`)
    check(
      Math.abs(cliff - 7.125) < 0.005 && MAX_TRI_DEG < cliff,
      `the cliff is at atan(2/CHUNK_RES) and MAX_TRI_DEG sits below it`,
      `${cliff.toFixed(3)} deg`
    )
    check(below > 10, 'at MAX_TRI_DEG the tree still subdivides', `${below} leaves`)
    check(above === 1, 'one step past the cliff the whole world is a single chunk', `${above} leaf`)
  }

  // --- 4. the MIN_TRI_DEG floor, and the slot pool ------------------------
  //
  // §18 section "slot pool". The current selection is exempt from eviction in terrain-v2.js, so the WORST case over the sweep -- not the mean -- plus the PINNED_CHUNKS base layer has to fit SLOT_COUNT, and overflow THROWS.
  //
  // Asserted in BOTH directions. "1.5 fits" alone would pass for any floor at or above 1.5, which makes the constant arbitrary; "and 1.4 does not" is what makes it the floor.

  console.log('\nMIN_TRI_DEG budget (the slot pool floor)')
  console.log(
    `        ${CAMS.length} selections (${CAMS.length / 4} positions x 4 headings, half airborne), ` +
      `pool ${SLOT_COUNT} + ${PINNED_CHUNKS} pinned, terrain's third of the ${TRI_BUDGET / 1000}k budget is ` +
      `${(TRI_BUDGET / 3000).toFixed(0)}k`
  )
  // The "unbounded" column runs the identical sweep with info omitted, so range degrades to the horizontal distance. hypot(dx,dy,dz) is never less than hypot(dx,dz), so unbounded range is a lower bound on range and therefore an UPPER bound on refinement -- for every height field, not just this file's stand-in. That is what lets a floor be set before v2's field exists: a cap that fits the unbounded column cannot be broken by whatever the field turns out to be. Drawn triangles inherit the same bound, because refining a node can only add leaves to the eye cone, never remove them.
  console.log('        "unbounded" = same sweep with no vertical bounds: a field-INDEPENDENT upper bound.\n')
  console.log(
    `        ${'cap'.padStart(5)} | ${'bounded'.padStart(7)} ${'+pin'.padStart(5)} | ${'unbnd'.padStart(6)} ${'+pin'.padStart(5)} | ` +
      `${`fits ${SLOT_COUNT}?`.padStart(11)} | ${'drawn'.padStart(5)} ${'tris'.padStart(6)} ${'ubound'.padStart(6)} ${'%§0'.padStart(5)}`
  )
  const ladder = new Map()
  for (const cap of [0.9, 1.0, 1.1, 1.2, 1.5, 2.0, 3.0, 4.0, 5.72]) {
    const r = worstAt(cap)
    const u = worstAt(cap, { info: null })
    ladder.set(cap, { ...r, unbounded: u.worst, uTris: u.tris })
    const fits = r.worst + PINNED_CHUNKS <= SLOT_COUNT && u.worst + PINNED_CHUNKS <= SLOT_COUNT
    const mark = cap === MIN_TRI_DEG ? '  <-- MIN_TRI_DEG' : cap === LOD.triDeg ? '  <-- LOD.triDeg' : ''
    console.log(
      `        ${cap.toFixed(2).padStart(5)} | ${String(r.worst).padStart(7)} ${String(r.worst + PINNED_CHUNKS).padStart(5)} | ` +
        `${String(u.worst).padStart(6)} ${String(u.worst + PINNED_CHUNKS).padStart(5)} | ${(fits ? 'yes' : 'NO').padStart(11)} | ` +
        `${String(r.drawn).padStart(5)} ${`${(r.tris / 1000).toFixed(0)}k`.padStart(6)} ${`${(u.tris / 1000).toFixed(0)}k`.padStart(6)} ` +
        `${`${((r.tris / TRI_BUDGET) * 100).toFixed(0)}%`.padStart(5)}${mark}`
    )
  }
  {
    const fits = ladder.get(MIN_TRI_DEG)
    if (!fits) throw new Error('the ladder must contain MIN_TRI_DEG')
    check(
      fits.unbounded + PINNED_CHUNKS <= SLOT_COUNT,
      `the pool covers the finest reachable setting (${MIN_TRI_DEG} deg) for ANY height field`,
      `unbounded ${fits.unbounded} + ${PINNED_CHUNKS} vs ${SLOT_COUNT}  [bounded worst at ${fits.at}]`
    )
    // WHICH WALL BINDS, and the answer CHANGED when MAX_DEPTH came down from 13 to 10.
    //
    // This check used to read the other way: `finer.unbounded + PINNED > SLOT_COUNT`, i.e. one 0.1 step finer than the floor overflows the pool, therefore the floor is tight and MIN_TRI_DEG is the edge of what 1024 slots can hold. That was true at the deeper cap. It is false now -- the whole sweep fits, 0.9 included -- because a shallower cap removes exactly the levels that pack leaves near the camera, so the pool gained slack across the entire knob range at once.
    //
    // So the honest claim is no longer "the floor is tight" but "the pool is not the wall". There are two walls, they behave differently, and MIN_TRI_DEG now sits far inside the pool one: SLOT_COUNT is a hard throw, while §0's triangle third is a frame rate you can choose to spend, and at the floor the ladder is already drawing multiples of that third. Asserting which wall binds is worth more than asserting a tightness that a cap change can silently retire, and it is the number a reader moving MIN_TRI_DEG actually needs.
    check(
      fits.uTris > (TRI_BUDGET / 3) * 1.5,
      `and the wall at the floor is the TRIANGLE budget, not the pool`,
      `${(fits.uTris / 1000).toFixed(0)}k drawn = ${((fits.uTris / (TRI_BUDGET / 3)) * 100).toFixed(0)}% of terrain's third, while the pool has ${SLOT_COUNT - fits.unbounded - PINNED_CHUNKS} slots spare`
    )
    const dflt = ladder.get(LOD.triDeg)
    check(
      dflt.unbounded + PINNED_CHUNKS <= SLOT_COUNT,
      `the shipped default (${LOD.triDeg} deg) fits with headroom for the LRU`,
      `${SLOT_COUNT - dflt.unbounded - PINNED_CHUNKS} slots spare at the upper bound`
    )
    // §0 holds terrain to a third of the frame. Asserted on the field-independent column, so this claim survives the real height field landing.
    check(
      dflt.uTris < TRI_BUDGET / 3,
      `worst-case DRAWN terrain at ${LOD.triDeg} deg leaves the budget to props`,
      `${(dflt.uTris / 1000).toFixed(0)}k of ${(TRI_BUDGET / 3000).toFixed(0)}k`
    )
    // Printed rather than asserted, because "it fits" and "it fits comfortably" are different claims and only the first one is true here.
    console.log(
      `\n        NOTE  triDeg ${LOD.triDeg} draws ${(dflt.tris / 1000).toFixed(0)}k, at most ${(dflt.uTris / 1000).toFixed(0)}k = ` +
        `${((dflt.uTris / (TRI_BUDGET / 3)) * 100).toFixed(0)}% of terrain's §0 third. It fits with no margin worth ` +
        `having.\n              An XR route takes 4.0 (${(ladder.get(4.0).uTris / 1000).toFixed(0)}k, ` +
        `${((ladder.get(4.0).uTris / (TRI_BUDGET / 3)) * 100).toFixed(0)}%) or coarser.`
    )

    // The periphery grading. Priced at BOTH ends of the knob, because how much it buys is a function of the cap.
    //
    // WHAT IT BUYS ALSO CHANGED WITH THE CAP. At MAX_DEPTH 13 flat periphery overflowed the pool at the floor, so grading was the difference between fitting and throwing and this check asserted exactly that. At 10 flat fits everywhere, so grading is no longer rescuing the pool -- it is saving leaves, and a leaf is 640 triangles whatever it costs in slots. That makes it a TRIANGLE saving now, which is the currency that is actually short, so it is priced in triangles here rather than in slots.
    console.log('')
    let worstSaving = 1
    for (const cap of [LOD.triDeg, MIN_TRI_DEG]) {
      const g = ladder.get(cap)
      const flat = worstAt(cap, { periphDeg: cap })
      const saved = 1 - g.worst / flat.worst
      if (saved < worstSaving) worstSaving = saved
      console.log(
        `        periphery grading at ${cap.toFixed(1)} deg: ${g.worst} graded vs ${flat.worst} flat ` +
          `(${(saved * 100).toFixed(0)}% saved = ${(((flat.worst - g.worst) * 640) / 1000).toFixed(0)}k triangles) -- ` +
          `flat ${flat.worst + PINNED_CHUNKS > SLOT_COUNT ? 'OVERFLOWS' : 'still fits'} the pool`
      )
    }
    check(
      worstSaving > 0.1,
      'the graded periphery pays for itself in triangles at both ends of the knob, not just at the floor',
      `worst of the two ends saves ${(worstSaving * 100).toFixed(0)}% of leaves`
    )

    // What the four extra levels actually cost. This is the measurement SLOT_COUNT 1024 rests on, and config.js states it in prose.
    const byDepth = [6, 8, 10, MAX_DEPTH - 1, MAX_DEPTH].map((d) => `${d} -> ${worstAt(MIN_TRI_DEG, { maxDepth: d }).worst}`)
    console.log(`\n        worst selection at ${MIN_TRI_DEG} deg by MAX_DEPTH:  ${byDepth.join('   ')}   leaves`)
    const shallow = worstAt(MIN_TRI_DEG, { maxDepth: MAX_DEPTH - 4 }).worst
    check(
      fits.worst < shallow * 2,
      'each extra level adds a ring, not a quadrupling (the premise SLOT_COUNT rests on)',
      `depth ${MAX_DEPTH - 4} -> ${shallow}, depth ${MAX_DEPTH} -> ${fits.worst}, ${(fits.worst / shallow).toFixed(2)}x for four levels`
    )
  }

  // --- 5. does it actually reach the cap underfoot? ------------------------
  //
  // MAX_DEPTH is a CAP, not a target -- the angular rule decides what is reached -- so "the cap allows a 50 cm cell" is not the same statement as "standing on the ground you get one", and only the second one is the feature.
  //
  // The direction of this section INVERTED when the cap came down from 13 to 10. At 13 the interesting risk was falling short: the rule wanted 8.6 cm underfoot, the cap allowed 6.25 cm, and the question was whether selection actually got there. At 10 the cap is well coarser than anything the rule wants at eye height, so reaching it is not in doubt -- what this now pins is that the cap SATURATES, i.e. the ground under her feet is always at the finest tier the tree has, and no closer camera, finer triDeg or flatter patch can talk it into another level. That saturation is the whole reason the cap is the triangle lever it is.

  console.log('\nreaches the cap underfoot')
  {
    let worstCell = 0
    let worstAtPos = null
    const spots = [
      [0, 0],
      [0.15, -0.73],
      [-0.407, 0.271],
      [0.299, -0.163],
      [0.964, -0.964],
    ]
    for (const [fx, fz] of spots) {
      const x = fx * WORLD_HALF
      const z = fz * WORLD_HALF
      const cam = { x, y: groundAt(x, z) + 1.65, z, yaw: 0.4 }
      const sel = selectNodes(cam, { info })
      let finest = Infinity
      let deepest = 0
      for (const n of sel) {
        const cell = n.size / CHUNK_RES
        if (cell < finest) finest = cell
        if (n.depth > deepest) deepest = n.depth
      }
      console.log(
        `        eye at ${x.toFixed(0).padStart(7)},${z.toFixed(0).padStart(7)}: depth ${deepest}, ` +
          `finest cell ${finest.toFixed(4)}m, ${sel.length} leaves`
      )
      if (finest > worstCell) {
        worstCell = finest
        worstAtPos = `${x.toFixed(0)},${z.toFixed(0)}`
      }
    }
    const capCell = WORLD_SIZE / 2 ** MAX_DEPTH / CHUNK_RES
    check(
      worstCell <= capCell,
      `at eye height on the ground the finest cell is the cap's own ${(capCell * 100).toFixed(0)} cm`,
      `worst of the five spots ${worstCell.toFixed(4)}m at ${worstAtPos}`
    )
    // And the cap is what STOPPED it, not the rule running out of appetite. At triDeg 3.0 and 1.65 m of eye height the rule wants 1.65 * tan(3) = 8.6 cm, comfortably finer than the 50 cm the cap allows, so selection saturates against the cap rather than converging under it. If this ever inverts -- the rule wanting coarser than the cap at eye height -- then lowering MAX_DEPTH further would stop buying triangles and the lever moves to triDeg.
    const want = 1.65 * Math.tan((LOD.triDeg * Math.PI) / 180)
    check(
      want < capCell,
      `the rule's target underfoot (${(want * 100).toFixed(1)}cm) is finer than the cap, so the cap binds`,
      `${(want * 100).toFixed(2)}cm wanted vs ${(capCell * 100).toFixed(1)}cm allowed`
    )
  }

  // --- 6. angular inversions ----------------------------------------------
  //
  // v1's reported defect, stated as a number and reproduced verbatim from probe-lod.mjs section 3: how often is nearer ground drawn at a COARSER angular resolution than ground at least 1.5x further away? "Angular" is load-bearing -- a nearer leaf being physically bigger is what LOD IS; a nearer leaf looking blockier is the seam the complaint was about.
  //
  // THE OBVIOUS ASSERTION IS THE WRONG ONE, and finding that out is most of what this section is for. quadtree.js quotes 12.1% for v1's rule, so "v2 must be at or under 12.1%" looks like the check to write. It is not, because this metric is a function of three things and depth is the only one the assertion would be trying to hold:
  //
  //   THE CAP. Measured on v1's own rule, field and camera set, varying nothing but the cap: 1.2 -> 9.57%, 2.0 -> 12.61%, 3.0 -> 15.57%, 5.72 -> 22.99%. The rate rises with the cap because a coarser cap admits a wider band between a leaf that just split and one that just failed to, and this metric flags anything past 1.5x. Comparing v2 at 3.0 against a number taken at 1.2 measures the knob, not the tree.
  //
  //   THE FIELD. The 12.1% in quadtree.js does not reproduce today: v1's rule on v1's current terrain at cap 1.2 measures 9.57%, and at its shipped 5.72 probe-lod.mjs prints 24.41%. The terrain moved under the constant. That is design/lessons.md's first entry happening again, and it is why the comparison below is re-measured rather than quoted.
  //
  //   THE SWEEP. v1's figure is 60 cameras; this is 2424.
  //
  // So the claim actually worth gating is the controlled one -- SAME field, SAME sweep, SAME metric, SAME cap, varying ONLY MAX_DEPTH -- because "does going four levels deeper make the seams worse" is the question a deeper tree raises and the only one any of this can answer. It does not: deepening is neutral to mildly favourable, which makes sense, since the extra levels land on ground near the camera that is already the finest thing on screen.
  //
  // The absolute number is reported alongside and held under a stated ceiling, so a regression that made the default behave like a much coarser cap would still be caught.

  console.log('\nangular inversions (nearer ground blockier than ground 1.5x further out)')
  {
    const rateAt = (triDeg, maxDepth) => {
      let inv = 0
      let pairs = 0
      let worst = null
      for (const cam of CAMS) {
        const sel = selectNodes(cam, { triDeg, maxDepth, info })
        const v = []
        for (const n of sel) {
          if (!inCone(cam, n.x, n.z, n.size, EYE_HALF_ANGLE)) continue
          const r = Math.max(nodeRange(cam, n.x, n.z, n.size, info.get(n.key)), 1)
          // Leaves closer than 50 m are dropped. Not to flatter the number: the leaf she is STANDING IN has a range of ~1 m, so it subtends tens of degrees by arithmetic alone and swamps every comparison it appears in -- and it is guaranteed to be at full depth.
          if (r < 50) continue
          v.push({ n, r, triDeg: ((n.size / CHUNK_RES) / r) * DEG })
        }
        v.sort((a, b) => a.r - b.r)
        for (let i = 0; i < v.length; i++) {
          for (let j = i + 1; j < v.length; j += 5) {
            if (v[j].r < v[i].r * 1.5) continue
            pairs++
            if (v[i].triDeg > v[j].triDeg * 1.5) {
              inv++
              const sev = v[i].triDeg / v[j].triDeg
              if (!worst || sev > worst.sev) worst = { sev, near: v[i], far: v[j] }
            }
          }
        }
      }
      return { rate: (inv / pairs) * 100, pairs, worst }
    }

    // The controlled comparison: only MAX_DEPTH moves.
    console.log(`        ${'cap'.padStart(5)} | ${`depth ${MAX_DEPTH - 4}`.padStart(13)} ${`depth ${MAX_DEPTH - 2}`.padStart(9)} ${`depth ${MAX_DEPTH}`.padStart(9)}`)
    let deeperIsWorse = 0
    for (const cap of [MIN_TRI_DEG, 2.0, LOD.triDeg, 5.72]) {
      const a = rateAt(cap, MAX_DEPTH - 4)
      const b = rateAt(cap, MAX_DEPTH - 2)
      const c = rateAt(cap, MAX_DEPTH)
      if (c.rate > a.rate + 1e-9) deeperIsWorse++
      console.log(
        `        ${cap.toFixed(2).padStart(5)} | ${`${a.rate.toFixed(2)}%`.padStart(13)} ${`${b.rate.toFixed(2)}%`.padStart(9)} ` +
          `${`${c.rate.toFixed(2)}%`.padStart(9)}`
      )
    }
    check(
      deeperIsWorse === 0,
      `MAX_DEPTH ${MAX_DEPTH} is no worse than a ${MAX_DEPTH - 4}-deep tree at every cap (same field, sweep, metric)`,
      `${deeperIsWorse} of 4 caps regressed`
    )

    // The absolute number at the shipped default.
    const CEIL = 25.0
    const here = rateAt(LOD.triDeg, MAX_DEPTH)
    console.log(
      `\n        at the shipped ${LOD.triDeg} deg: ${here.rate.toFixed(2)}% of ${here.pairs} sampled pairs` +
        `   (v1's rule on v1's field: 15.57% at 3.0, 9.57% at 1.2)`
    )
    if (here.worst) {
      console.log(
        `        worst case: ${here.worst.near.n.size}m leaf at ${here.worst.near.r.toFixed(0)}m = ` +
          `${here.worst.near.triDeg.toFixed(2)} deg/tri  vs  ${here.worst.far.n.size}m leaf at ` +
          `${here.worst.far.r.toFixed(0)}m = ${here.worst.far.triDeg.toFixed(2)} deg/tri  (${here.worst.sev.toFixed(1)}x)` +
          `   -- v1's pre-fix worst was 20.8x`
      )
    }
    // 25% is where this rule sits at a 5.72 cap (27.09% measured), so the ceiling is "the default must not start behaving like the coarsest setting anyone would ship". It is not a quality target; the quality target is the CAP, which is bounded by construction.
    check(here.rate < CEIL, `and under the stated ${CEIL}% ceiling`, `${here.rate.toFixed(2)}%`)
    console.log('        The residual does not go to zero for a structural reason: a node can only halve, so')
    console.log('        two leaves either side of the quantisation boundary read as a 2x "inversion" while')
    console.log('        both sit inside the cap. What has to be bounded is the CAP, and it is by construction.')
  }

  // --- 7. selection time ---------------------------------------------------
  //
  // Depth 14 recurses 14 levels four ways. That was the one shape question worth asking about carrying v1's recursive descent forward, and it is answered by measurement rather than by converting it to an explicit stack on a hunch -- design/lessons.md is largely about the second thing.
  //
  // The ceiling: selection runs at 12 Hz on the render thread, so one selection has an 83 ms window and shares a 16 ms frame with everything else. 1 ms is the stated limit -- 6% of one frame, once every five frames. The measured p99 at MIN_TRI_DEG, the finest the knob reaches, is ~0.18 ms, so the ceiling is roughly 5x the measurement: loose enough to survive a slower machine or a v8 version bump, tight enough that an algorithmic regression cannot hide under it. Reintroducing v1's string keys alone would cost 1.6x.

  console.log('\nselection time')
  {
    const CEIL_MS = 1.0
    const t = ladder.get(LOD.triDeg).times
    const tf = ladder.get(MIN_TRI_DEG).times
    console.log(
      `        triDeg ${LOD.triDeg}: p50 ${pct(t, 0.5).toFixed(3)}ms  p90 ${pct(t, 0.9).toFixed(3)}ms  ` +
        `p99 ${pct(t, 0.99).toFixed(3)}ms  max ${Math.max(...t).toFixed(3)}ms  over ${t.length} selections`
    )
    console.log(
      `        triDeg ${MIN_TRI_DEG}: p50 ${pct(tf, 0.5).toFixed(3)}ms  p90 ${pct(tf, 0.9).toFixed(3)}ms  ` +
        `p99 ${pct(tf, 0.99).toFixed(3)}ms  max ${Math.max(...tf).toFixed(3)}ms   (the finest the knob reaches)`
    )
    check(pct(t, 0.99) < CEIL_MS, `p99 selection at the default is under ${CEIL_MS}ms`, `${pct(t, 0.99).toFixed(3)}ms`)
    check(pct(tf, 0.99) < CEIL_MS, `p99 selection at MIN_TRI_DEG is under ${CEIL_MS}ms`, `${pct(tf, 0.99).toFixed(3)}ms`)
    console.log(`        ${boundsCache.size} distinct nodes bounded across the whole sweep`)
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) throw new Error(`check-v2-quadtree: ${failures} check(s) failed`)
}

// Self-run when invoked directly; scripts/check-v2.mjs imports run() instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
