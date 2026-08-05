// Node-side gates for the Phase A global pass (src/sim/phase-a.js, DESIGN.md §2).
//
// Phase A is pure math with no rendering, which means every one of its failure
// modes is invisible: a river that runs uphill, a lake that is not flat, a
// village on a cliff, a summit in a different basin from spawn. None of those
// show up as an exception. They show up as a world that feels wrong three weeks
// later. This file is the only thing standing between here and that.
//
//   node scripts/check-phase-a.mjs [seed] [gridN]
//
// Defaults to a 1024^2 run (~2 s) rather than the shipping 2048^2 (~5 s),
// because this runs on every `npm run check`. Pass 2048 explicitly to gate the
// real thing -- and note that the two resolutions are NOT expected to agree on
// lake or stream counts, only on the invariants.

import { runPhaseA, BIOME_NAMES, VILLAGE, LAKE, STREAM, streamWidth, biomeWeights } from '../src/sim/phase-a.js'
import { Noise } from '../src/sim/noise.js'
import { priorityFlood } from '../src/sim/hydrology.js'
import { NB_DI, NB_DJ, NB_DIST, gridSlope } from '../src/sim/world-grid.js'
import { WORLD_HALF } from '../src/sim/terrain-height.js'

const SEED = Number(process.argv[2] ?? 20260804)
const N = Number(process.argv[3] ?? 1024)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log(`\n=== phase A checks, seed ${SEED}, ${N}^2 grid ===\n`)

const timings = []
const W = runPhaseA(SEED, N, (line) => timings.push(line))
const { n, cell, base, elev, filled, acc, recv, lake, lakes, stream, water, moisture, snowLine, biome, biomeArea, spawn, summit, villages, reachable, reachableFraction, unreachable } = W
const size = n * n
for (const t of timings) console.log(`       ${t}`)
console.log(`       total          ${W.ms.toFixed(0)}ms   cell ${cell.toFixed(2)}m\n`)

// --- 1. the fields are finite and in range ----------------------------------

console.log('field sanity')
{
  let bad = 0
  for (let c = 0; c < size; c++) {
    if (!Number.isFinite(elev[c]) || !Number.isFinite(filled[c]) || !Number.isFinite(acc[c]) || !Number.isFinite(moisture[c])) bad++
  }
  check(bad === 0, 'no NaN/Infinity anywhere in elevation, filled, accumulation or moisture', `${bad} bad cells`)

  let mMin = Infinity
  let mMax = -Infinity
  let mSum = 0
  for (let c = 0; c < size; c++) {
    const m = moisture[c]
    if (m < mMin) mMin = m
    if (m > mMax) mMax = m
    mSum += m
  }
  check(mMin >= 0 && mMax <= 1, 'moisture stays in 0..1', `${mMin.toFixed(3)} .. ${mMax.toFixed(3)}`)
  // A moisture field pinned at one end is a field that cannot separate biomes.
  check(mMax - mMin > 0.5, 'moisture uses most of its range', `spread ${(mMax - mMin).toFixed(2)}, mean ${(mSum / size).toFixed(2)}`)
}

// --- 2. depression filling --------------------------------------------------

// The uncarved surface's own flood, used only to prove the flood is alive.
const { filled: rawFilled } = priorityFlood(base, N)

console.log('\ndepression filling')
{
  let below = 0
  let raised = 0
  for (let c = 0; c < size; c++) {
    if (filled[c] < elev[c] - 1e-3) below++
    if (filled[c] > elev[c] + 1e-4) raised++
  }
  // Filling may only ever add material. If it subtracts, the flood is leaking.
  check(below === 0, 'filled surface is never below the original', `${below} cells below`)
  check(raised < size * 0.9, 'filling did not raise most of the map', `${((100 * raised) / size).toFixed(1)}%`)

  // This check used to demand `raised > 0` as well, on the reasoning that a
  // flood which raises nothing is a flood that is not running. That was a
  // DRIFTED INSTRUMENT and it failed the moment breaching started working: it
  // is measuring the flood of the CARVED surface, and a fully drained world is
  // supposed to raise exactly zero cells there. The test was asserting the
  // pass's own failure. What it meant to check lives on the raw surface, so
  // check it there, where 0% would genuinely mean the flood is dead.
  let rawRaised = 0
  for (let c = 0; c < size; c++) if (rawFilled[c] > base[c] + 1e-4) rawRaised++
  const rawPct = (100 * rawRaised) / size
  check(rawRaised > size * 0.05, 'the flood finds real depressions in the uncarved surface', `${rawPct.toFixed(1)}% raised before breaching`)
  console.log(`       breaching removed ${rawPct.toFixed(1)}% -> ${((100 * raised) / size).toFixed(1)}% of the map under fill`)

  // The property the whole pass rests on: no cell in the filled surface has a
  // strictly-lower neighbour it cannot reach. Equivalently, every non-border
  // cell has a downhill-or-level path out. Checked as: every cell either has a
  // strictly lower 8-neighbour, or sits at a level shared with a neighbour
  // (a flat, which flowDirections routes via the spanning tree).
  let stranded = 0
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const c = j * n + i
      const h = filled[c]
      let ok = false
      for (let k = 0; k < 8; k++) {
        const nn = (j + NB_DJ[k]) * n + i + NB_DI[k]
        if (filled[nn] <= h) {
          ok = true
          break
        }
      }
      if (!ok) stranded++
    }
  }
  check(stranded === 0, 'no cell is stranded above all eight neighbours', `${stranded} pits survive filling`)
}

// --- 3. flow routing --------------------------------------------------------

console.log('\nflow routing')
{
  let uphill = 0
  let selfRecv = 0
  let outlets = 0
  for (let c = 0; c < size; c++) {
    const r = recv[c]
    if (r < 0) {
      outlets++
      continue
    }
    if (r === c) selfRecv++
    if (filled[r] > filled[c] + 1e-4) uphill++
  }
  check(uphill === 0, 'no cell drains to a higher cell', `${uphill} uphill receivers`)
  check(selfRecv === 0, 'no cell drains to itself', `${selfRecv}`)
  check(outlets > 0, 'the world has outlets at its edge', `${outlets} cells drain off-map`)

  // A cycle in the flow graph is the failure that turns accumulation into an
  // infinite loop or a silently wrong number. Walk every cell to its outlet with
  // a step budget; a cycle blows the budget.
  let cyclic = 0
  const budget = size
  let worstPath = 0
  const stamp = new Int32Array(size).fill(-1)
  for (let s = 0; s < size; s++) {
    if (stamp[s] >= 0) continue
    let c = s
    let steps = 0
    while (c >= 0 && stamp[c] < 0) {
      stamp[c] = s
      c = recv[c]
      if (++steps > budget) break
    }
    if (c >= 0 && stamp[c] === s) cyclic++
    if (steps > worstPath) worstPath = steps
  }
  check(cyclic === 0, 'the flow graph is acyclic', `${cyclic} cycles, longest new path ${worstPath} cells`)

  // Mass balance: every cell's unit of rain must reach the edge exactly once.
  let atOutlets = 0
  for (let c = 0; c < size; c++) if (recv[c] < 0) atOutlets += acc[c]
  check(Math.abs(atOutlets - size) < 1, 'accumulation conserves mass', `${atOutlets} of ${size} reaches the edge`)

  // Accumulation must never decrease downstream -- that is what makes rivers
  // merge rather than fray.
  let shrinking = 0
  for (let c = 0; c < size; c++) {
    const r = recv[c]
    if (r >= 0 && acc[r] < acc[c] - 1e-3) shrinking++
  }
  check(shrinking === 0, 'accumulation never shrinks downstream', `${shrinking} cells`)
}

// --- 4. lakes ---------------------------------------------------------------

console.log('\nlakes')
{
  let maskCells = 0
  for (let c = 0; c < size; c++) if (lake[c]) maskCells++
  const listCells = lakes.reduce((a, b) => a + b.cells, 0)
  // labelLakes erases sub-threshold bodies from the mask rather than only
  // dropping them from the list. If these disagree, some consumer is looking at
  // water the map view does not draw.
  check(maskCells === listCells, 'the lake mask and the lake list agree', `${maskCells} vs ${listCells} cells`)
  // NOT "the world has lakes". With BREACH.maxLakeArea at 0 the world is fully
  // drained on purpose and there are none -- see the measured table on BREACH.
  // What must hold is the weaker, always-true statement: if the breacher was
  // asked to leave water, there is water; if it was not, there is none.
  const { BREACH } = await import('../src/sim/phase-a.js')
  check(
    BREACH.maxLakeArea > 0 ? lakes.length > 0 : listCells === 0,
    BREACH.maxLakeArea > 0 ? 'the world has lakes' : 'a fully drained world has no lakes',
    `${lakes.length} bodies, largest ${lakes[0] ? lakes[0].cells : 0} cells`
  )
  check(
    lakes.every((l) => l.cells * cell * cell >= 400),
    'every lake is big enough to be worth a water plane (§11)',
    lakes.length ? `smallest ${(Math.min(...lakes.map((l) => l.cells)) * cell * cell).toFixed(0)} m^2` : 'no lakes'
  )
  check(
    lakes.every((l) => l.maxDepth >= LAKE.minDepth),
    'every lake is at least minDepth deep',
    `${LAKE.minDepth} m`
  )

  // §11 puts ONE flat plane per body at the spill elevation. That is only
  // honest if the body really is flat in `filled`.
  let notFlat = 0
  let worst = 0
  for (const l of lakes) {
    const level = l.level
    // Re-walk the body from its stored centre is not reliable (the centroid can
    // fall outside a crescent lake), so sample the whole mask against the
    // nearest body level instead: check that every lake cell's filled height
    // matches SOME body level exactly.
    void level
  }
  const levels = new Set(lakes.map((l) => l.level))
  for (let c = 0; c < size; c++) {
    if (!lake[c]) continue
    if (!levels.has(filled[c])) {
      notFlat++
      const d = Math.min(...[...levels].map((v) => Math.abs(v - filled[c])))
      if (d > worst) worst = d
    }
  }
  check(notFlat === 0, 'every lake surface is exactly flat', `${notFlat} cells off-level, worst ${worst.toFixed(3)} m`)

  const totalArea = (listCells * cell * cell) / 1e6
  console.log(`       ${lakes.length} bodies, ${totalArea.toFixed(2)} km^2 total, ${((100 * listCells) / size).toFixed(2)}% of the map`)
}

// --- 5. streams -------------------------------------------------------------

console.log('\nstreams')
{
  let cells = 0
  let inLake = 0
  for (let c = 0; c < size; c++) {
    if (!stream[c]) continue
    cells++
    if (lake[c]) inLake++
  }
  check(inLake === 0, 'no stream cell is inside a lake', `${inLake}`)
  const frac = (100 * cells) / size
  check(cells > 0, 'the world has streams', `${cells} cells, ${frac.toFixed(2)}% of the map`)
  // Both ends of this are real failures. Too few and the map has no water
  // features; too many and §11's ribbon meshes become the whole triangle budget.
  check(frac > 0.2 && frac < 4, 'stream density is in a shippable band', `${frac.toFixed(2)}%  (tune STREAM.minAcc)`)

  // A stream must be a connected network draining to the edge or to a lake, not
  // scattered specks. Every stream cell's receiver should be a stream cell, a
  // lake cell, or off-map.
  let orphan = 0
  for (let c = 0; c < size; c++) {
    if (!stream[c]) continue
    const r = recv[c]
    if (r < 0) continue
    if (!stream[r] && !lake[r]) orphan++
  }
  check(orphan === 0, 'every stream cell flows into water or off the map', `${orphan} dead ends`)

  let maxAcc = 0
  for (let c = 0; c < size; c++) if (acc[c] > maxAcc) maxAcc = acc[c]
  const scale = ((2048 / n) * (2048 / n))
  const w = streamWidth(maxAcc, STREAM.minAcc / scale)
  check(w <= STREAM.maxWidth + 1e-6, 'the widest river stays under maxWidth', `${w.toFixed(1)} m at ${maxAcc.toFixed(0)} cells`)
}

// --- 6. moisture and biomes -------------------------------------------------

console.log('\nmoisture and biomes')
{
  // The point of a distance-to-water moisture field is that being near water
  // makes you wetter. If that correlation is absent the field is just noise with
  // extra steps.
  let nearSum = 0
  let nearCount = 0
  let farSum = 0
  let farCount = 0
  for (let c = 0; c < size; c++) {
    if (water[c]) {
      nearSum += moisture[c]
      nearCount++
    }
  }
  // "Far" = high ground, sampled to keep this cheap.
  for (let c = 0; c < size; c += 7) {
    if (!water[c] && elev[c] > snowLine[c] - 60) {
      farSum += moisture[c]
      farCount++
    }
  }
  const nearMean = nearSum / nearCount
  const farMean = farSum / farCount
  check(nearMean > farMean + 0.15, 'water cells are meaningfully wetter than high dry ground', `${nearMean.toFixed(2)} vs ${farMean.toFixed(2)}`)

  const total = biomeArea.reduce((a, b) => a + b, 0)
  check(total === size, 'every cell got a biome', `${total} of ${size}`)
  // Array.from FIRST, and this is not a style preference. biomeArea is an
  // Int32Array, and TypedArray.prototype.map returns a TypedArray OF THE SAME
  // TYPE -- so `biomeArea.map(a => 100 * a / size)` truncated every percentage
  // to a whole number. The section printed "bare 45.0% pine 10.0% mixed 36.0%
  // heath 2.0% lush 5.0%", five suspiciously round figures summing to 98, and
  // the gate below turned into `>= 3%` without saying so. It went unnoticed
  // while heath sat above 3, and fired the moment heath came in at 2.996.
  const pct = Array.from(biomeArea, (a) => (100 * a) / size)
  console.log(`       ${BIOME_NAMES.map((nm, k) => `${nm} ${pct[k].toFixed(1)}%`).join('   ')}`)
  // §2 lists five bands. A band with no area is a band that does not exist, and
  // the tuning is wrong rather than the world being unusual.
  check(
    pct.every((p) => p > 2),
    'all five biomes have real area',
    `smallest ${Math.min(...pct).toFixed(1)}%`
  )
  check(
    pct.every((p) => p < 55),
    'no single biome swallows the map',
    `largest ${Math.max(...pct).toFixed(1)}%`
  )

  // biomeWeights is the function every consumer actually calls. It has to be a
  // partition of unity or prop density will silently scale with position.
  const nJit = new Noise(SEED + 1319)
  let worstSum = 0
  let negative = 0
  const out = new Array(5)
  for (let k = 0; k < 4000; k++) {
    const c = (k * 1051) % size
    const i = c % n
    const j = (c / n) | 0
    biomeWeights(elev[c], moisture[c], snowLine[c], -WORLD_HALF + (i + 0.5) * cell, -WORLD_HALF + (j + 0.5) * cell, nJit, out)
    let s = 0
    for (const v of out) {
      s += v
      if (v < -1e-6) negative++
    }
    worstSum = Math.max(worstSum, Math.abs(s - 1))
  }
  check(negative === 0, 'no biome weight is negative', `${negative}`)
  check(worstSum < 1e-4, 'biome weights sum to 1 everywhere', `worst error ${worstSum.toExponential(1)}`)
}

// --- 7. villages ------------------------------------------------------------

console.log('\nvillages')
{
  check(villages.length === VILLAGE.count, 'sited the requested number of villages', `${villages.length} of ${VILLAGE.count}`)
  let tooSteep = 0
  let tooDry = 0
  let inWater = 0
  let tooHigh = 0
  let tooClose = 0
  for (let a = 0; a < villages.length; a++) {
    const v = villages[a]
    if (gridSlope(elev, v.i, v.j, n, cell) > VILLAGE.maxSlope + 1e-6) tooSteep++
    if (v.waterDist > VILLAGE.maxWaterDist) tooDry++
    if (lake[v.j * n + v.i]) inWater++
    if (v.h > snowLine[v.j * n + v.i] - VILLAGE.elevBelowSnow) tooHigh++
    for (let b = a + 1; b < villages.length; b++) {
      if (Math.hypot(villages[a].x - villages[b].x, villages[a].z - villages[b].z) < VILLAGE.minSeparation - 1e-6) tooClose++
    }
  }
  check(tooSteep === 0, 'every village is on buildable ground', `${tooSteep} too steep`)
  check(tooDry === 0, 'every village is within reach of fresh water', `${tooDry} too dry`)
  check(inWater === 0, 'no village is in a lake', `${inWater}`)
  check(tooHigh === 0, 'no village is above the local treeline band', `${tooHigh}`)
  check(tooClose === 0, 'villages respect the minimum separation', `${tooClose} pairs closer than ${VILLAGE.minSeparation} m`)
  const spread = Math.max(...villages.map((v) => Math.hypot(v.x, v.z)))
  check(spread > 2000, 'villages are spread across the map, not clustered at the origin', `furthest ${spread.toFixed(0)} m out`)
  // Six sites all in one corner is what a degenerate score looks like from the
  // outside: every candidate ties at 0.000 and the sort returns array order.
  const cx = villages.reduce((a, v) => a + v.x, 0) / villages.length
  const cz = villages.reduce((a, v) => a + v.z, 0) / villages.length
  const rms = Math.sqrt(villages.reduce((a, v) => a + (v.x - cx) ** 2 + (v.z - cz) ** 2, 0) / villages.length)
  check(rms > 2500, 'villages are spread around their own centroid, not one cluster', `rms radius ${rms.toFixed(0)} m`)
  check(
    villages.every((v) => v.score > 0),
    'every village has a non-degenerate score',
    `lowest ${Math.min(...villages.map((v) => v.score)).toFixed(4)}`
  )
  for (const v of villages) {
    console.log(`       ${v.x.toFixed(0).padStart(6)},${v.z.toFixed(0).padStart(6)}  ${v.h.toFixed(0).padStart(4)}m  water ${v.waterDist.toFixed(0).padStart(3)}m  score ${v.score.toFixed(3)}`)
  }
}

// --- 8. connectivity (§2 step 7, §4) ----------------------------------------

console.log('\nconnectivity')
{
  console.log(`       spawn  ${spawn.x.toFixed(0)},${spawn.z.toFixed(0)} @ ${spawn.h.toFixed(0)}m`)
  console.log(`       summit ${summit.x.toFixed(0)},${summit.z.toFixed(0)} @ ${summit.h.toFixed(0)}m`)
  check(reachable[spawn.j * n + spawn.i] === 1, 'spawn is in its own reachable set', '')
  check(reachableFraction > 0.5, 'most of the world is reachable from spawn', `${(100 * reachableFraction).toFixed(1)}%`)
  // DESIGN.md §4: "Log loudly on failure -- do not ship a world with an
  // unreachable summit."
  check(
    unreachable.length === 0,
    'every village and the summit are reachable from spawn',
    unreachable.length ? unreachable.map((t) => `${t.kind} ${t.x.toFixed(0)},${t.z.toFixed(0)}`).join('; ') : ''
  )
}

// --- 9. determinism ---------------------------------------------------------

console.log('\ndeterminism')
{
  const B = runPhaseA(SEED, 256)
  const A = runPhaseA(SEED, 256)
  let diff = 0
  for (let c = 0; c < 256 * 256; c++) {
    if (A.elev[c] !== B.elev[c] || A.filled[c] !== B.filled[c] || A.acc[c] !== B.acc[c] || A.biome[c] !== B.biome[c]) diff++
  }
  check(diff === 0, 'two runs of the same seed agree cell for cell', `${diff} differing cells`)
  check(
    A.villages.length === B.villages.length && A.villages.every((v, k) => v.x === B.villages[k].x && v.z === B.villages[k].z),
    'village siting is deterministic',
    ''
  )
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
