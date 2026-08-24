// How many prop LOD tiers, and where do they cross over?
//
//   node scripts/probe-prop-lod.mjs
//
// DESIGN.md §5 states a prop LOD table (600 tris to 30 m, 150 to 80 m, a 4-tri
// cross-quad to 500 m) and §0 then measured the real triangle ceiling at half
// what that table was written against. So the table is due a re-derivation, and
// "how many mesh LODs do we need in addition to the billboard" is the question
// this file answers.
//
// THREE FINDINGS, and the second one reverses the premise this probe started on.
//
//   1. The crossovers are NOT triangle-starved. At a dense-forest 0.08 stems/m^2
//      the whole three-tier chain costs ~81k of a ~545k prop budget. The §5
//      table was written defensively and the distances in it are far tighter
//      than the measured ceiling requires.
//
//   2. So the binding constraint is not triangles, it is PARALLAX. A billboard's
//      error is that it does not turn as you walk past it, and that error is an
//      angle -- prop depth over distance. Triangle count has nothing to do with
//      it. This is why the answer is not "add another mesh LOD": at the distance
//      a third mesh tier would occupy, a 45-triangle decimated conifer has no
//      needles left, while a 128px billboard still does. A billboard is not
//      worse geometry, it is a different representation whose quality comes from
//      its texture, and the only thing it is actually bad at is parallax.
//
//   3. The untested regime is instance COUNT, not triangle count (section 6).
//
// Units: `renderer.info` frame totals, matching the §0 HUD. No per-eye halving.

import { TRI_BUDGET } from '../src/budget.js'

const CEILING = TRI_BUDGET // §0. Quest 2, derived -- re-measure on device
const TERRAIN = 45_000 // §5, measured at triDeg 5.72 (71 drawn leaves x 640)
const OTHER = 60_000 // village, water, weather, sky -- §5's estimates summed

// What "chaotically lush and saturated" means as a number. Real closed-canopy
// conifer stands run 500-1,500 stems/ha; 800/ha = 0.08/m^2 is a dense but not
// absurd mature forest. This is the input the derivation is most sensitive to,
// which is why section 5 sweeps it rather than trusting it.
const DENSITY = 0.08

// Fraction of a disc actually in front of you. Quest 2 is ~89 deg horizontal,
// and per-instance frustum culling (§5) removes the rest.
const FOV_FRAC = 89 / 360

// Quest 2, per eye: the WebXR default framebuffer is ~1440 x 1584 over roughly
// 89 x 93 deg. That is 17 px/deg against the 23 this was written for, so every
// pixel figure below is about three quarters of what it used to print -- props
// go illegible ~26% nearer than the old numbers claimed.
const PX_PER_DEG = 1584 / 93

const TREE_H = 13.5 // scatter.js buildConifer, the tall variant
const TREE_D = 4.2 // canopy depth -- what parallax is measured against

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0))
const screenPx = (h, d) => ((2 * Math.atan(h / (2 * d)) * 180) / Math.PI) * PX_PER_DEG
const parallaxDeg = (depth, d) => (Math.atan(depth / d) * 180) / Math.PI

function tierTris(rInner, rOuter, tris, density = DENSITY) {
  return Math.PI * (rOuter * rOuter - rInner * rInner) * FOV_FRAC * density * tris
}
function totalTris(rings, density = DENSITY) {
  let sum = 0
  let prev = 0
  for (const [r, t] of rings) {
    sum += tierTris(prev, r, t, density)
    prev = r
  }
  return sum
}

const budget = CEILING - TERRAIN - OTHER
const treeBudget = budget * 0.5 // grass, rock, bush and village take the rest

console.log('=== 1. The budget props actually have ===\n')
console.log(`  device ceiling              ${fmt(CEILING)} tris/frame  (§0, derived)`)
console.log(`  terrain, all LOD rings     -${fmt(TERRAIN)}             (§5, measured)`)
console.log(`  village + water + sky      -${fmt(OTHER)}             (§5, estimated)`)
console.log(`  ---------------------------------------`)
console.log(`  left for props              ${fmt(budget)}, of which trees ~${fmt(treeBudget)}`)

console.log('\n=== 2. Triangles are not the binding constraint ===\n')
console.log('  A tier is worth its triangles while they stay bigger than a pixel.')
console.log(`  A ${TREE_H} m tree, and the tri count that would saturate its footprint:\n`)
console.log('    dist     px tall   tris to saturate   §5 draws')
for (const d of [10, 25, 50, 80, 120, 250, 500]) {
  const px = screenPx(TREE_H, d)
  const sat = Math.max(4, Math.round((px * px) / 3))
  const drawn = d <= 30 ? '600 (LOD0)' : d <= 80 ? '150 (LOD1)' : '4 (billboard)'
  console.log(`    ${String(d).padStart(4)} m  ${px.toFixed(0).padStart(7)}   ${fmt(sat).padStart(16)}   ${drawn}`)
}
console.log('\n  Perception would keep LOD0 out past 400 m; §5 switches at 30 m. But')
console.log('  the budget does not force that either -- see section 4. §5\'s distances')
console.log('  are simply conservative, and there is room to open them up.')

console.log('\n=== 3. What billboards are actually bad at ===\n')
console.log('  Not detail -- a 128px impostor carries more foliage than a 45-tri mesh.')
console.log('  Parallax: the card does not turn as you walk past it. The error is an')
console.log('  angle, prop depth over distance, and no triangle count touches it.\n')
console.log(`    dist   parallax err   px tall   verdict for a ${TREE_D} m deep canopy`)
for (const d of [30, 60, 90, 130, 180, 250]) {
  const p = parallaxDeg(TREE_D, d)
  const px = screenPx(TREE_H, d)
  const v = p > 4 ? 'obvious card' : p > 2 ? 'noticeable when strafing' : 'acceptable'
  console.log(`    ${String(d).padStart(4)} m   ${p.toFixed(1).padStart(9)} deg ${px.toFixed(0).padStart(9)}   ${v}`)
}
console.log('\n  Under 2 deg the swim is below what reads as wrong at walking pace.')
const bbCross = TREE_D / Math.tan((2 * Math.PI) / 180)
console.log(`  That puts the billboard crossover at depth / tan(2 deg) = ${bbCross.toFixed(0)} m`)
console.log('  for this tree -- a RULE keyed to the prop, not one distance for all of')
console.log('  them. A 6 m deep cabin wants 172 m; a 0.6 m boulder wants 17 m.')

console.log('\n=== 4. Two mesh LODs or three? Equal-budget comparison ===\n')
console.log('  The honest question is not "which costs less" -- it is, for the SAME')
console.log('  triangles, which pushes real geometry further out before the flat card')
console.log('  starts. Solving each chain for its outermost mesh radius:\n')

function solveA(r0) {
  // 500 @ r0, 130 @ r1, 6 beyond to 250. Solve for r1.
  const c = Math.PI * FOV_FRAC * DENSITY
  const avail = treeBudget / c - 6 * 250 * 250
  const r1sq = (avail - (500 - 130) * r0 * r0) / (130 - 6)
  return r1sq > 0 ? Math.sqrt(r1sq) : NaN
}
function solveB(r0, r1) {
  // 500 @ r0, 160 @ r1, 45 @ r2, 6 beyond to 250. Solve for r2.
  const c = Math.PI * FOV_FRAC * DENSITY
  const avail = treeBudget / c - 6 * 250 * 250
  const r2sq = (avail - (500 - 160) * r0 * r0 - (160 - 45) * r1 * r1) / (45 - 6)
  return r2sq > 0 ? Math.sqrt(r2sq) : NaN
}
console.log('    chain                                 outermost mesh   flat card from')
console.log(`    2 mesh: 500@30 / 130@r1               ${solveA(30).toFixed(0).padStart(11)} m   ${solveA(30).toFixed(0)} m`)
console.log(`    3 mesh: 500@30 / 160@80 / 45@r2       ${solveB(30, 80).toFixed(0).padStart(11)} m   ${solveB(30, 80).toFixed(0)} m`)
console.log('\n  The three-tier chain does push geometry further -- but look at what it')
console.log('  is buying with the extra tier. At 150-230 m a decimated conifer is down')
console.log(`  to 45 triangles and ${screenPx(TREE_H, 190).toFixed(0)} px tall: it has no needles, no silhouette,`)
console.log('  and it is a green cone. The billboard it replaces has a 128px texture of')
console.log('  the real canopy. Section 3 says the card is already under 2 deg of')
console.log('  parallax error out there, which was the only thing wrong with it.')
console.log('\n  => The third mesh tier spends a slot, a build step and a pop event to')
console.log('     replace a good representation with a worse one. TWO mesh LODs.')

console.log('\n=== 5. Sensitivity to density -- the input that decides ===\n')
const chain = [
  [30, 500],
  [130, 130],
  [250, 6],
]
console.log('    density/m^2   stems/ha   tris at 30/130/250   headroom vs tree budget')
for (const d of [0.02, 0.04, 0.08, 0.12, 0.2, 0.3]) {
  const t = totalTris(chain, d)
  const pct = ((t / treeBudget) * 100).toFixed(0)
  console.log(
    `    ${d.toFixed(2).padStart(11)}   ${String(Math.round(d * 10000)).padStart(8)}   ${fmt(t).padStart(18)}   ${pct.padStart(4)}%  ${t <= treeBudget ? '' : 'OVER'}`,
  )
}
console.log('\n  Density moves cost linearly, crossovers only quadratically -- so density')
console.log('  is the lever the look actually hangs on, and the LOD table is downstream')
console.log('  of it. Lushness is affordable up to ~0.2 stems/m^2 before triangles bind.')

console.log('\n=== 6. The number nobody has measured ===\n')
const bbCount = Math.PI * (250 * 250 - 130 * 130) * FOV_FRAC * DENSITY
const meshCount = Math.PI * 130 * 130 * FOV_FRAC * DENSITY
console.log(`  Instances in view at ${DENSITY}/m^2 with a 30 / 130 / 250 m chain:`)
console.log(`    mesh instances (0-130 m)    ${Math.round(meshCount).toString().padStart(6)}`)
console.log(`    billboards    (130-250 m)   ${Math.round(bbCount).toString().padStart(6)}`)
console.log(`    total                       ${Math.round(meshCount + bbCount).toString().padStart(6)}`)
console.log('\n  §0 tested to 8,000 instances -- but at ~190 tris each, where the scene')
console.log('  was geometry-bound long before instance bookkeeping mattered. Thousands')
console.log('  of 6-tri billboards is the OPPOSITE regime, and §0 records it as')
console.log('  explicitly untested. This is the first thing to read off the HUD on the')
console.log('  next headset visit, and it is the reason clump impostors are a planned')
console.log(`  tier rather than an optimisation: one quad per ~20 trees takes the far`)
console.log(`  band to ~${Math.round(bbCount / 20)} instances, well inside what §0 did measure.`)
