// Does this terrain have the MACRO structure that lakes and trunk rivers need?
//
//   node scripts/probe-macro.mjs [seed] [n]
//
// Every other probe in this repo measures the terrain at the scale you can see
// from standing on it -- peak spacing, slope histograms, summit apex angle,
// silhouette. All of them came out green on a world that DESIGN.md §2 then
// diagnosed as having no structure above ~2 km, which is why the drainage is
// ten thousand disconnected puddles instead of a river system. None of them
// could have caught it: they all look at features 200-800 m across, and the
// defect is at 4-8 km.
//
// So this instrument asks three questions the others structurally cannot, and
// all three are downstream of the same property of the height field:
//
//   1. RELIEF SPECTRUM. Blur the elevation at increasing radii and ask how much
//      relief survives. A real range keeps most of it out to 5-20 km -- that is
//      what makes it a range rather than a field of hills. fbm's self-similar
//      spectrum decays smoothly, so if the curve is already near zero at 4 km
//      the world has nothing for a river to run along.
//
//   2. BASIN INVENTORY. A 500 m lake needs a closed basin whose water surface
//      encloses ~0.2 km^2 at its spill level. This counts them, on the RAW
//      surface before breaching, because breaching is precisely the thing that
//      destroys them -- the inventory is of what the terrain *offers*, and
//      selective retention (§2) is the decision about what to keep.
//
//   3. DRAINAGE CONCENTRATION. The trunk-river question, and the one number
//      that matters most: what fraction of the world drains through the top few
//      outlets. A world of ten thousand independent catchments spreads it
//      evenly and reads as texture; a world with real river systems concentrates
//      it. This is the difference between "water everywhere" and "a river".
//
// The point of all three is that they are keyed to what the WATER needs, not to
// what looks nice from a viewpoint. "Rivers winding through valleys between
// villages" is a shape complaint; these are the numbers it has to become.

import { TerrainHeight, WORLD_SIZE } from '../src/sim/terrain-height.js'
import { priorityFlood, breachDepressions, flowDirections, flowAccumulation, distanceTo } from '../src/sim/hydrology.js'
import { sampleElevation, NB_DI, NB_DJ, CELL } from '../src/sim/world-grid.js'
import { BREACH, LAKE, STREAM, labelLakes } from '../src/sim/phase-a.js'

const SEED = Number(process.argv[2] ?? 20260804)
const N = Number(process.argv[3] ?? 1024)
const cell = WORLD_SIZE / N
const size = N * N

// Blur radii in metres. The top of the range is deliberately half the world:
// past that a "blur" is just the world mean and the number stops meaning
// anything. 260 / 1000 / 2000 / 4000 are the four §2 already recorded, kept so
// this run is comparable against the numbers in the design doc.
const RADII = [260, 500, 1000, 2000, 4000, 8000]

// A lake this wide reads as a lake rather than as a pond, and it is the number
// the world is being asked for. Area of the equivalent circle, since basins are
// not circular and a diameter threshold on a lobed shape is meaningless.
const LAKE_WIDTHS = [200, 500, 1000, 2000]
const areaFor = (d) => Math.PI * (d / 2) ** 2

const fmt = (v, w = 7, p = 1) => v.toFixed(p).padStart(w)
const pct = (v, w = 6) => `${(v * 100).toFixed(1).padStart(w)}%`
const km2 = (cells) => (cells * cell * cell) / 1e6
const equivDiam = (cells) => 2 * Math.sqrt((cells * cell * cell) / Math.PI)

console.log(`\nseed ${SEED}   grid ${N}^2   cell ${cell.toFixed(1)} m   world ${(WORLD_SIZE / 1000).toFixed(1)} km\n`)

const th = new TerrainHeight(SEED)
let t = performance.now()
const base = sampleElevation(th, N)
console.log(`elevation      ${(performance.now() - t).toFixed(0)}ms`)

// --- 1. relief spectrum ------------------------------------------------------
//
// Separable box blur, run TWICE so the kernel is a triangle rather than a
// rectangle. A single box has large side lobes in frequency -- it does not
// cleanly remove the scales it claims to -- and the whole point here is to
// attribute surviving relief to a scale. Two passes is cheap and much closer to
// a gaussian than one.
//
// "Relief surviving" is std(blurred) / std(original). Not RMS of the residual:
// the question is how much LANDFORM is left at this scale, which is the energy
// remaining in the smoothed field, not the energy removed from it.
function boxBlur(src, radiusCells) {
  const r = Math.max(1, Math.round(radiusCells))
  const a = new Float32Array(size)
  const b = new Float32Array(size)
  const win = 2 * r + 1
  // horizontal
  for (let j = 0; j < N; j++) {
    const row = j * N
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(N - 1, Math.max(0, i))]
    for (let i = 0; i < N; i++) {
      a[row + i] = sum / win
      sum -= src[row + Math.min(N - 1, Math.max(0, i - r))]
      sum += src[row + Math.min(N - 1, Math.max(0, i + r + 1))]
    }
  }
  // vertical
  for (let i = 0; i < N; i++) {
    let sum = 0
    for (let j = -r; j <= r; j++) sum += a[Math.min(N - 1, Math.max(0, j)) * N + i]
    for (let j = 0; j < N; j++) {
      b[j * N + i] = sum / win
      sum -= a[Math.min(N - 1, Math.max(0, j - r)) * N + i]
      sum += a[Math.min(N - 1, Math.max(0, j + r + 1)) * N + i]
    }
  }
  return b
}

function stdev(arr) {
  let mean = 0
  for (let c = 0; c < size; c++) mean += arr[c]
  mean /= size
  let v = 0
  for (let c = 0; c < size; c++) {
    const d = arr[c] - mean
    v += d * d
  }
  return Math.sqrt(v / size)
}

const std0 = stdev(base)
console.log(`\n-- 1. RELIEF SPECTRUM -------------------------------------------------`)
console.log(`   how much landform survives a blur at each scale. A real range keeps`)
console.log(`   most of its relief out to 5-20 km; fbm alone decays to nothing by 4.`)
console.log(`\n   total relief (1 sigma) ${fmt(std0)} m,  p2..p98 span ${fmt(span(base))} m\n`)
console.log(`   radius     surviving   relief`)
for (const R of RADII) {
  // Two box passes of radius r/2 give an effective radius of about r.
  const blurred = boxBlur(boxBlur(base, R / cell / 2), R / cell / 2)
  const s = stdev(blurred)
  const bar = '#'.repeat(Math.round((s / std0) * 40))
  console.log(`   ${String(R).padStart(5)} m    ${pct(s / std0)}  ${fmt(s, 6)} m  ${bar}`)
}

function span(arr) {
  const a = Float32Array.from(arr).sort()
  return a[Math.floor(size * 0.98)] - a[Math.floor(size * 0.02)]
}

// --- 2. basin inventory ------------------------------------------------------
//
// On the raw surface. priorityFlood raises every closed depression to its spill
// elevation, so `filled - base` IS the water column a basin would hold if
// nothing drained it, and the connected components of that are the candidate
// lakes. Reusing labelLakes rather than reimplementing the component walk is
// deliberate: this file and phase-a.js must agree on what a water body is, and
// the surest way to get a fourteenth drifted instrument is to write the second
// version of a definition that already exists.
t = performance.now()
const raw = priorityFlood(base, N)
console.log(`\npriority-flood ${(performance.now() - t).toFixed(0)}ms`)

const areaScale = (CELL * CELL) / (cell * cell)
const minLakeCells = Math.max(2, Math.round(LAKE.minCells * areaScale))
const lakeMask = new Uint8Array(size)
for (let c = 0; c < size; c++) if (raw.filled[c] - base[c] >= LAKE.minDepth) lakeMask[c] = 1
const bodies = labelLakes(lakeMask, raw.filled, base, N, cell, minLakeCells)

let flooded = 0
for (let c = 0; c < size; c++) if (raw.filled[c] > base[c] + 1e-3) flooded++

console.log(`\n-- 2. BASIN INVENTORY (raw surface, before any breaching) --------------`)
console.log(`   what the terrain OFFERS as closed basins. Retention is a later choice;`)
console.log(`   this is whether there is anything worth retaining.`)
console.log(`\n   map in closed depression   ${pct(flooded / size)}`)
console.log(`   candidate bodies (>=${LAKE.minDepth} m deep, >=${minLakeCells} cells)  ${bodies.length}\n`)
// AREA IS NOT WIDTH, and on this terrain the difference is the whole answer.
//
// The first version of this section reported equivalent diameter -- 2*sqrt(A/pi)
// -- and announced 94 basins over 500 m wide, the largest 3.1 km across. The
// flow map then showed a uniform cellular lattice with no lake in it anywhere.
// Both were true: a flooded region on rough ground is DENDRITIC, a thin network
// threading every hollow, and the equivalent diameter of a branching shape is a
// meaningless number. Same error DESIGN.md §3 already records for plain size,
// arriving in a new place, and it nearly bought a "the drainage is fine" verdict.
//
// The honest test is the largest disc that fits INSIDE the body, because that is
// literally the question -- "is there 500 m of open water here". One distance
// transform against the complement of the lake mask gives every cell its
// distance to the nearest shore, so the deepest-inside cell of each body is its
// inscribed radius. O(size), one pass, no per-body work.
const shore = new Uint8Array(size)
for (let c = 0; c < size; c++) shore[c] = lakeMask[c] ? 0 : 1
const toShore = distanceTo(shore, N, cell)

const inscribed = new Float32Array(bodies.length)
{
  const seen = new Uint8Array(size)
  const queue = new Int32Array(size)
  for (let bi = 0; bi < bodies.length; bi++) {
    const b = bodies[bi]
    const s = b.j * N + b.i
    if (!lakeMask[s] || seen[s]) continue
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    let best = 0
    while (head < tail) {
      const c = queue[head++]
      if (toShore[c] > best) best = toShore[c]
      const ci = c % N
      const cj = (c / N) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue
        const nn = nj * N + ni
        if (seen[nn] || !lakeMask[nn]) continue
        seen[nn] = 1
        queue[tail++] = nn
      }
    }
    inscribed[bi] = best * 2 // radius -> diameter of open water
  }
}

console.log(`   min OPEN WATER width   bodies   (largest inscribed disc, not sqrt(area))`)
for (const d of LAKE_WIDTHS) {
  let k = 0
  for (let bi = 0; bi < bodies.length; bi++) if (inscribed[bi] >= d) k++
  console.log(`   ${String(d).padStart(10)} m   ${String(k).padStart(6)}`)
}

const widest = [...bodies.keys()].sort((a, b) => inscribed[b] - inscribed[a]).slice(0, 12)
console.log(`\n   the 12 with the most open water:`)
console.log(`     open water    area      sprawl    depth    surface elev`)
for (const bi of widest) {
  const b = bodies[bi]
  // Sprawl: equivalent diameter over inscribed diameter. 1.0 is a round pond;
  // 10x is a branching flooded valley network wearing a lake's area.
  const sprawl = equivDiam(b.cells) / Math.max(1e-6, inscribed[bi])
  console.log(
    `   ${fmt(inscribed[bi], 9, 0)} m ${fmt(km2(b.cells), 8, 2)} km2 ${fmt(sprawl, 6, 1)}x ${fmt(b.maxDepth, 7)} m ${fmt(b.level, 9)} m`
  )
}

// Cascade potential: does a basin spill into another basin? This is the "high
// ponds feeding lower lakes" look, and it is a property of the basin HIERARCHY
// that priority-flood already computed -- not something to be built on top.
// From each body, follow the flow field off its own surface and see where it
// lands.
const recvRaw = flowDirections(raw.filled, raw.tree, N)
const bodyAt = new Int32Array(size).fill(-1)
{
  // Re-walk the components to tag cells by body, since labelLakes returns only
  // centroids. Cheap, and it keeps labelLakes as the single definition.
  const seen = new Uint8Array(size)
  const queue = new Int32Array(size)
  let id = 0
  for (let s = 0; s < size; s++) {
    if (!lakeMask[s] || seen[s]) continue
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    while (head < tail) {
      const c = queue[head++]
      const ci = c % N
      const cj = (c / N) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue
        const nn = nj * N + ni
        if (seen[nn] || !lakeMask[nn]) continue
        seen[nn] = 1
        queue[tail++] = nn
      }
    }
    if (tail >= minLakeCells) for (let k = 0; k < tail; k++) bodyAt[queue[k]] = id++
    // ids are per-component; only identity matters below, not the number
  }
}

let chained = 0
for (const b of bodies) {
  const start = b.j * N + b.i
  const from = bodyAt[start]
  let c = start
  for (let step = 0; step < 20000; step++) {
    const r = recvRaw[c]
    if (r < 0) break // off the edge of the world
    c = r
    const hit = bodyAt[c]
    if (hit >= 0 && hit !== from) {
      chained++
      break
    }
  }
}
console.log(`\n   bodies whose outflow reaches another body  ${chained} of ${bodies.length}  ${pct(chained / Math.max(1, bodies.length))}`)
console.log(`   (this is the high-tarn-spilling-into-a-lower-lake look, and it is a`)
console.log(`    property of the basin hierarchy rather than something to be added)`)

// --- 3. drainage concentration ----------------------------------------------
//
// Now breach to convergence -- the same loop phase-a.js runs, with the same
// constants -- and route flow over the drained surface. The question is not
// "does water reach the edge" (§2's gates already prove it does) but "does it
// COLLECT on the way".
t = performance.now()
let elev = base
for (let p = 0; p < BREACH.passes; p++) {
  const c = breachDepressions(elev, N, cell, BREACH)
  elev = c.elev
  if (c.breached === 0) break
}
const drained = priorityFlood(elev, N)
const recv = flowDirections(drained.filled, drained.tree, N)
const acc = flowAccumulation(recv, drained.order, size)
console.log(`\nbreach + route ${(performance.now() - t).toFixed(0)}ms`)

// Outlets are cells that leave the world. Their accumulation is the catchment
// area of everything upstream, so sorting them ranks the world's river systems.
const outlets = []
for (let c = 0; c < size; c++) if (recv[c] < 0) outlets.push(acc[c])
outlets.sort((a, b) => b - a)
const totalOut = outlets.reduce((s, v) => s + v, 0)

const cum = (k) => outlets.slice(0, k).reduce((s, v) => s + v, 0) / totalOut

const minAcc = STREAM.minAcc * areaScale
let streamCells = 0
for (let c = 0; c < size; c++) if (acc[c] >= minAcc) streamCells++

console.log(`\n-- 3. CHANNEL HIERARCHY (after breaching, the shipped pipeline) --------`)
console.log(`   the trunk-river question, and the FIRST version of this section got it`)
console.log(`   wrong. It reported the share of the world drained by the top N outlets`)
console.log(`   -- 81.5% through ten of them -- and concluded the drainage was healthy.`)
console.log(`   The flow map showed a uniform cellular lattice. Both were true: that`)
console.log(`   metric measures how catchments PARTITION, which a lattice does just as`)
console.log(`   well as a river system, and says nothing about whether flow COLLECTS`)
console.log(`   into a mainstem on the way. What follows measures the network's shape.`)
console.log(`\n   outlets to the map edge     ${outlets.length}`)
console.log(`   largest catchment          ${fmt(km2(outlets[0]), 8, 2)} km2   ${pct(outlets[0] / totalOut)} of the world`)

// Channel length per decade of catchment. This is the shape test.
//
// A dendritic network is self-similar in a specific way: each decade of
// catchment carries roughly a constant SHARE of the total length, because a
// trunk ten times bigger is also ten times rarer. So a healthy spectrum spans
// many decades with length falling off gently. A cellular lattice piles nearly
// all its length into the one or two decades at which the cells close, and has
// almost nothing above -- there is no trunk for the length to go into.
const DECADES = [0.1, 0.3, 1, 3, 10, 30, 100, 300]
console.log(`\n   channel length by catchment size  (a dendritic net spans many decades;`)
console.log(`   a lattice piles everything into one or two and has no trunk above it)`)
console.log(`\n     catchment          length     share`)
let totalLen = 0
const lens = []
for (let d = 0; d < DECADES.length; d++) {
  const lo = (DECADES[d] * 1e6) / (cell * cell)
  const hi = d + 1 < DECADES.length ? (DECADES[d + 1] * 1e6) / (cell * cell) : Infinity
  let cells = 0
  for (let c = 0; c < size; c++) if (acc[c] >= lo && acc[c] < hi) cells++
  // Cells -> centreline length. Roughly 1.09 x cell for a D8 path mixing
  // orthogonal and diagonal steps; the constant cancels out of every share.
  const L = (cells * cell * 1.09) / 1000
  lens.push(L)
  totalLen += L
}
for (let d = 0; d < DECADES.length; d++) {
  const hi = d + 1 < DECADES.length ? `-${DECADES[d + 1]}` : '+  '
  const bar = '#'.repeat(Math.round((lens[d] / Math.max(1e-9, totalLen)) * 60))
  console.log(
    `   ${(DECADES[d] + hi).padStart(10)} km2 ${fmt(lens[d], 9, 1)} km ${pct(lens[d] / Math.max(1e-9, totalLen))}  ${bar}`
  )
}

// Drainage density, and its inverse which is the number you can see in the map.
// The lattice in the flow render has channels every ~600 m everywhere; a world
// with trunk valleys has them kilometres apart in the low country and dense only
// in the headwaters. A single uniform spacing IS the defect.
const chanLen = lens.reduce((s, v) => s + v, 0)
const areaKm2 = (WORLD_SIZE / 1000) ** 2
console.log(`\n   drainage density            ${fmt(chanLen / areaKm2, 7, 2)} km per km2`)
console.log(`   mean spacing between channels ${fmt((areaKm2 / chanLen) * 1000, 6, 0)} m   <- uniform spacing is the lattice`)

// Longest mainstem: from the highest-accumulation outlet, walk upstream always
// taking the tributary with the most catchment. That is the river you would
// follow on foot, and its length is how far "up the valley" actually goes.
let head = 0
for (let c = 0; c < size; c++) if (recv[c] < 0 && acc[c] === outlets[0]) head = c
let len = 0
{
  // Build a child list on the fly by scanning neighbours -- cheaper in memory
  // than inverting recv for the whole grid when only one path is walked.
  let c = head
  for (let step = 0; step < 100000; step++) {
    const ci = c % N
    const cj = (c / N) | 0
    let best = -1
    let bestAcc = 0
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB_DI[k]
      const nj = cj + NB_DJ[k]
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue
      const nn = nj * N + ni
      if (recv[nn] !== c) continue // not a donor
      if (acc[nn] > bestAcc) {
        bestAcc = acc[nn]
        best = nn
      }
    }
    if (best < 0 || bestAcc < minAcc) break
    len += Math.hypot((best % N) - ci, ((best / N) | 0) - cj) * cell
    c = best
  }
}

console.log(`\n   channel cells (acc >= ${STREAM.minAcc} cells of catchment)  ${pct(streamCells / size)}`)
console.log(`   longest mainstem            ${fmt(len / 1000, 7, 2)} km   (world is ${(WORLD_SIZE / 1000).toFixed(1)} km across)`)
console.log('')
