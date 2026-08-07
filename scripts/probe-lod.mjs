// Does the LOD rule deliver a CONSISTENT screen-relative resolution?
//
//   node scripts/probe-lod.mjs [seed]
//
// Written against a specific complaint: from the air, whole quadrants of NEARER
// terrain drawn blockier than quadrants FURTHER away, with a hard seam between
// them. Section 3 is that complaint turned into a number.
//
// Everything here is measured in degrees subtended at the eye, because that is
// the only unit in which "consistent resolution" means anything -- a 64 m
// triangle is enormous underfoot and invisible on the horizon.
//
// Two different angles get measured and they are NOT interchangeable:
//
//   TRIANGLE   cell / range. How big one triangle looks. This is what was asked
//              for ("no visible triangle wider than a degree") and what bounds
//              per-vertex shading, so it governs snow-line stair-stepping.
//   ERROR      err / range. How WRONG the surface looks. This is what shows up
//              as a summit cut flat or a ridge faceted against the sky.
//
// A rule can hold one and miss the other, so both are reported. The old rule
// missed both; see BASELINE below.
//
// Measured against a 110 deg eye cone, NOT the 180 deg cone selection uses. The
// difference is streaming margin (quadtree.js VIEW_HALF_ANGLE) and it is a cost,
// never a credit -- so leaves outside the eye cone count against the slot budget
// and contribute nothing to any quality number here.

import { TerrainHeight } from '../src/sim/terrain-height.js'
import { CHUNK_RES } from '../src/sim/chunk-mesh.js'
import { LOD } from '../src/terrain/quadtree.js'
import { CHUNK_INDICES, SLOT_COUNT } from '../src/terrain/terrain.js'
import { TRI_BUDGET } from '../src/budget.js'
import { settle } from './lod-sim.mjs'

// The rule this replaced, measured on this exact camera set with this exact
// code, at commit ad80046:
//
//   git show ad80046:src/terrain/quadtree.js > /tmp/old.js   # then point
//   selectNodes(cam.x, cam.z, MAX_DEPTH, DEFAULT_SPLIT_K, buildElevationLod(th))
//   at the same view()/report() below.
//
// It is quoted rather than run because reviving it needs the elevation pyramid
// and the old five-positional-argument signature, and the point of keeping it is
// the comparison, not the code.
const BASELINE = {
  label: 'splitK 1.1 + elevation bias, horizontal range, no view culling (ad80046)',
  leavesMean: 259,
  leavesMax: 325,
  visTrisMean: 62,
  triP90: 2.51,
  triP99: 5.1,
  triMax: 9.22,
  errP90: 1.34,
  errMax: 5.72,
  top20Mean: 5.67,
  inversions: 30.75,
}

const SEED = Number(process.argv[2] ?? 20260804)
const th = new TerrainHeight(SEED)
const TRIS_PER_CHUNK = CHUNK_INDICES / 3
const DEG = 180 / Math.PI
const EYE_HALF_FOV = (55 * Math.PI) / 180

// Terrain's share of the frame. DESIGN.md holds it to roughly a third, the rest
// being aurora, water, props and the sky.
const TERRAIN_TRIS = TRI_BUDGET / 3

// The selection cannot be evicted (terrain.js _evict skips anything in _render),
// so the WORST-case leaf count has to fit here, not the average, and whatever is
// left over is the LRU retention that makes turning your head free.
const CACHE_CEIL = 720

let rs = 987654321
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const CAMS = []
for (let i = 0; i < 60; i++) {
  const x = (rnd() * 2 - 1) * 7000
  const z = (rnd() * 2 - 1) * 7000
  // Half on foot, half airborne. The reported artifact was worst from the air,
  // and the altitude term in the range test only does anything up there.
  const agl = i % 2 === 0 ? 1.7 : 150 + rnd() * 450
  CAMS.push({ x, z, y: th.heightAt(x, z) + agl, yaw: rnd() * Math.PI * 2, agl })
}

const pct = (a, p) => {
  if (!a.length) return 0
  const s = Float64Array.from(a).sort()
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)

const info = new Map() // shared: a node's vertical extent is a property of the world, not the camera

// Geometric error, measured HERE rather than in the mesher.
//
// This is deliberately duplicated work. The renderer no longer computes error at
// all (quadtree.js explains why it was removed), but "we removed it because it
// did not pay" is only an honest claim if the thing it would have bought is
// still being watched. So the probe measures it and reports it, and if the err
// columns below ever start drifting up while the triangle columns hold, that is
// the signal to put the term back.
//
// The mesh interpolates its own corner samples; the error is how far that
// departs from the real height field at the point where a bilinear patch is
// least constrained, which is the cell centre.
const errCache = new Map()
function nodeErr(n) {
  let e = errCache.get(n.key)
  if (e !== undefined) return e
  const step = n.size / CHUNK_RES
  e = 0
  for (let j = 0; j < CHUNK_RES; j++) {
    for (let i = 0; i < CHUNK_RES; i++) {
      const x0 = n.x + i * step
      const z0 = n.z + j * step
      const mid =
        (th.heightAt(x0, z0) +
          th.heightAt(x0 + step, z0) +
          th.heightAt(x0, z0 + step) +
          th.heightAt(x0 + step, z0 + step)) *
        0.25
      const d = Math.abs(th.heightAt(x0 + step * 0.5, z0 + step * 0.5) - mid)
      if (d > e) e = d
    }
  }
  errCache.set(n.key, e)
  return e
}

// What the eye actually sees of one settled selection.
//
// Leaves closer than 50 m are dropped from the quality statistics. Not to
// flatter the numbers: the leaf you are STANDING IN has a range of ~1 m, so it
// subtends tens of degrees by arithmetic alone and swamps every max() it appears
// in. It is also the one leaf guaranteed to be at full depth. Including it makes
// every rule look identical and equally terrible.
function view(cam, sel) {
  const out = []
  for (const n of sel) {
    const cx = n.x + n.size / 2
    const cz = n.z + n.size / 2
    const dist = Math.hypot(cx - cam.x, cz - cam.z)
    let d = Math.atan2(cx - cam.x, cz - cam.z) - cam.yaw
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    if (Math.abs(d) > EYE_HALF_FOV + Math.atan2(n.size * 0.71, Math.max(dist, 1))) continue

    const rec = info.get(n.key)
    const dx = Math.max(n.x - cam.x, 0, cam.x - (n.x + n.size))
    const dz = Math.max(n.z - cam.z, 0, cam.z - (n.z + n.size))
    const dy = rec ? Math.max(rec.minY - cam.y, 0, cam.y - rec.maxY) : 0
    const r = Math.max(Math.hypot(dx, dy, dz), 1)
    out.push({
      n,
      r,
      near: r < 50,
      triDeg: ((n.size / CHUNK_RES) / r) * DEG,
      errDeg: (nodeErr(n) / r) * DEG,
      area: (n.size * n.size) / (r * r), // solid angle up to a constant: "how much of the view is this"
    })
  }
  return out
}

function run(opts) {
  return CAMS.map((cam) => {
    const { sel } = settle(th, cam, info, opts)
    return { cam, sel, v: view(cam, sel) }
  })
}

const far = (rows, f) => rows.flatMap((r) => r.v.filter((x) => !x.near).map(f))

console.log(`\n=== LOD probe, seed ${SEED}, ${CAMS.length} cameras (half airborne) ===`)
console.log(
  `    ${TRIS_PER_CHUNK} tris/chunk, pool ${SLOT_COUNT} slots (${CACHE_CEIL} usable), terrain's share of budget ${TERRAIN_TRIS / 1000}k tris\n`
)

// --- 1. what the knob costs -------------------------------------------------

console.log('1. the knob. leaves is the SLOT question, visible tris is the BUDGET question.')
console.log('   "slack" = slots left for LRU retention after the WORST-CASE selection. Negative THROWS.\n')
console.log(
  `  ${'tri<='.padStart(5)} | ${'leaf~'.padStart(6)} ${'leafMAX'.padStart(7)} ${'slack'.padStart(6)} | ` +
    `${'vis~'.padStart(5)} ${'visMAX'.padStart(6)} | ${'tri p50'.padStart(7)} ${'tri p90'.padStart(7)} ${'triMAX'.padStart(6)} | ` +
    `${'err p50'.padStart(7)} ${'err p90'.padStart(7)}`
)
for (const triDeg of [1.0, 1.1, 1.2, 1.3, 1.6, 2.0]) {
  const rows = run({ triDeg })
  const leaves = rows.map((r) => r.sel.length)
  const vt = rows.map((r) => r.v.length * TRIS_PER_CHUNK)
  const tri = far(rows, (x) => x.triDeg)
  const err = far(rows, (x) => x.errDeg)
  const lmax = Math.max(...leaves)
  const here = triDeg === LOD.triDeg ? '  <-- shipped' : ''
  console.log(
    `  ${triDeg.toFixed(1).padStart(5)} | ${mean(leaves).toFixed(0).padStart(6)} ${String(lmax).padStart(7)} ` +
      `${String(CACHE_CEIL - lmax).padStart(6)} | ${(mean(vt) / 1000).toFixed(0).padStart(4)}k ${(Math.max(...vt) / 1000).toFixed(0).padStart(5)}k | ` +
      `${pct(tri, 0.5).toFixed(2).padStart(7)} ${pct(tri, 0.9).toFixed(2).padStart(7)} ${Math.max(...tri).toFixed(2).padStart(6)} | ` +
      `${pct(err, 0.5).toFixed(2).padStart(7)} ${pct(err, 0.9).toFixed(2).padStart(7)}${here}`
  )
}
console.log(
  `\n  baseline, same cameras: ${BASELINE.leavesMean} leaves~ / ${BASELINE.leavesMax} MAX, ` +
    `tri p90 ${BASELINE.triP90} MAX ${BASELINE.triMax}, err p90 ${BASELINE.errP90} MAX ${BASELINE.errMax}`
)
console.log(`  (${BASELINE.label})`)
console.log('\n  err is reported but NOT targeted -- see quadtree.js for why a rule that targeted it')
console.log('  directly was built, priced and removed. It is here so that decision stays falsifiable.')

// --- 2. the stated criterion ------------------------------------------------
//
// "the 20 peaks taking up the largest portion of your viewing area, rendered so
// all visible triangles are smaller than 1 degree, whereas remaining visible
// regions may degrade to 5 degrees."
//
// Largest-on-screen is ranked by solid angle, which is what "portion of your
// viewing area" means, and which -- unlike an elevation threshold -- picks up the
// low grass-and-rock humps nearby as readily as the snowy peaks far away. That
// distinction was explicitly asked for.
//
// The second half of the ask is met by construction rather than by tuning: the
// cap is global, so there is no 5-degree tail anywhere to degrade into. The
// spread between the best and worst visible triangle is what "consistent" means,
// and it is printed here for exactly that reason.

console.log('\n2. the 20 largest things on screen: how big is the worst triangle among them?\n')
console.log(`  ${'tri<='.padStart(5)} | ${'worst~'.padStart(6)} ${'worstMAX'.padStart(8)} | under 1.0 / 1.5 / 2.0 deg | worst ANYWHERE on screen`)
for (const triDeg of [1.0, LOD.triDeg, 1.6]) {
  const rows = run({ triDeg })
  const worst = rows
    .map((r) => {
      const top = r.v.filter((x) => !x.near).sort((a, b) => b.area - a.area).slice(0, 20)
      return top.length ? Math.max(...top.map((x) => x.triDeg)) : 0
    })
    .filter(Boolean)
  const anywhere = Math.max(...far(rows, (x) => x.triDeg))
  const share = (lim) => ((worst.filter((v) => v <= lim).length / worst.length) * 100).toFixed(0).padStart(3)
  console.log(
    `  ${triDeg.toFixed(1).padStart(5)} | ${mean(worst).toFixed(2).padStart(6)} ${Math.max(...worst).toFixed(2).padStart(8)} | ` +
      `      ${share(1.0)}% ${share(1.5)}% ${share(2.0)}% |  ${anywhere.toFixed(2)} deg`
  )
}
console.log(`\n  baseline: worst~ ${BASELINE.top20Mean} deg among the top 20, and ${BASELINE.triMax} deg somewhere on screen.`)
console.log('  1.0 is shown to price the literal target: see LOD.triDeg in quadtree.js for why it is')
console.log('  not what ships -- at 1.0 the worst-case selection does not fit in the slot pool.')

// --- 3. the reported defect -------------------------------------------------
//
// "some quadrants are extremely high detail, and then another adjacent square,
// which is CLOSER, the peaks are extremely low detail."
//
// Stated as a measurement: how often is nearer ground drawn at a COARSER angular
// resolution than ground at least 1.5x further away? Note "angular". A nearer
// leaf being physically bigger is not a defect -- it is the whole point of LOD.
// A nearer leaf looking blockier is the defect, and it is what the eye reads as
// a seam.

console.log('\n3. angular inversions -- nearer ground drawn BLOCKIER than ground 1.5x further out\n')
{
  const rows = run({ triDeg: LOD.triDeg })
  let inv = 0
  let pairs = 0
  let worst = null
  for (const r of rows) {
    const s = r.v.filter((x) => !x.near).sort((a, b) => a.r - b.r)
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j += 5) {
        const near = s[i]
        const fx = s[j]
        if (fx.r < near.r * 1.5) continue
        pairs++
        if (near.triDeg > fx.triDeg * 1.5) {
          inv++
          const sev = near.triDeg / fx.triDeg
          if (!worst || sev > worst.sev) worst = { sev, near, far: fx, cam: r.cam }
        }
      }
    }
  }
  console.log(`  shipped rule: ${((inv / pairs) * 100).toFixed(2)}% of ${pairs} sampled pairs`)
  console.log(`  baseline:     ${BASELINE.inversions}%`)
  if (worst) {
    console.log(
      `\n  worst surviving case: ${worst.near.n.size}m leaf at ${worst.near.r.toFixed(0)}m = ${worst.near.triDeg.toFixed(2)} deg/tri` +
        `  vs  ${worst.far.n.size}m leaf at ${worst.far.r.toFixed(0)}m = ${worst.far.triDeg.toFixed(2)} deg/tri  (${worst.sev.toFixed(1)}x)`
    )
    console.log('  baseline worst case:  1024m leaf at 398m = 9.22 deg/tri  vs  256m leaf at 2068m = 0.44 deg/tri  (20.8x)')
  }
  console.log('\n  The residual is not the old bug, and it does not go to zero for a structural reason:')
  console.log('  a node can only halve, so a leaf sits anywhere between the cap and half the cap, and')
  console.log('  two leaves at that quantisation boundary read as a 2x "inversion" while both are')
  console.log('  within tolerance. What has to be bounded is the CAP, and it is -- see triMAX above.')
}

// --- 4. is the resolution actually uniform? ---------------------------------
//
// Sections 1-3 bound the worst case. This asks the complementary question:
// across a single frame, how much does apparent resolution VARY? That is what
// "some quadrants extremely high detail, adjacent ones extremely low" describes,
// and a rule can hold a good maximum while still looking patchy.
//
// Measured within each camera and then summarised across cameras, because the
// eye compares what is on screen right now against the rest of what is on screen
// right now, not against a global average.

console.log('\n4. within a single frame, how uniform is the apparent resolution?\n')
{
  const rows = run({ triDeg: LOD.triDeg })
  const spreads = []
  const p10s = []
  const p90s = []
  let overFine = 0
  let leaves = 0
  for (const r of rows) {
    const t = r.v.filter((x) => !x.near)
    if (t.length < 20) continue
    const a = t.map((x) => x.triDeg)
    p10s.push(pct(a, 0.1))
    p90s.push(pct(a, 0.9))
    spreads.push(pct(a, 0.9) / pct(a, 0.1))
    // A leaf more than 2x finer than the cap could have been one level coarser
    // on its own account, and is only that fine because an ancestor split.
    for (const x of t) {
      leaves++
      if (x.triDeg < LOD.triDeg / 2) overFine++
    }
  }
  console.log(`  per frame, triangle angular size p10 ${mean(p10s).toFixed(2)} deg -> p90 ${mean(p90s).toFixed(2)} deg`)
  console.log(`  spread within a frame: ${mean(spreads).toFixed(2)}x on average, ${Math.max(...spreads).toFixed(2)}x at worst`)
  console.log(`  leaves finer than half the cap: ${((overFine / leaves) * 100).toFixed(0)}%`)
  console.log('')
  console.log('  2.00x is the floor, not 1.00x: quadtree nodes halve, so a leaf that just failed to')
  console.log('  split is exactly twice one that just did. The rest is the descent being top-down.')
  console.log('  A node is tested at the CLOSEST point of its box, so when it splits, all four')
  console.log('  children are refined -- including the far one that did not need it, and including')
  console.log('  low children of a tall parent, whose 3D range is much greater than their parent\'s.')
  console.log('  That over-refines, never under-refines, which is the safe direction and the reason')
  console.log('  the CAP in sections 1-3 is the number that governs how the terrain reads.')
  console.log(`\n  ${info.size} nodes measured across the whole sweep.\n`)
}
