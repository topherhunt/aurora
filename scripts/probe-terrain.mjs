// Measures the SHAPE of the height field, so TUNING in sim/terrain-height.js can
// be tuned against numbers instead of against a memory of the last screenshot.
//
// The question this exists to answer is "how big is a valley here". That is not
// something you can read off a noise frequency, because domain warp, the macro
// mask and the terrace pass all move it. So: sample a grid, find ridge peaks by
// prominence along every row and column, and report the spacing between them.
//
//   node scripts/probe-terrain.mjs [seed]

import { TerrainHeight, TUNING, SHRINK, WORLD_SIZE, WORLD_HALF } from '../src/sim/terrain-height.js'

const SEED = Number(process.argv[2] ?? 20260804)
const STEP = 16 // m between samples -- halved with SHRINK, because a 32 m probe
// against half-size landforms resolves half as many samples per peak, and peak
// spacing is exactly what this script exists to report.
const N = Math.floor(WORLD_SIZE / STEP) + 1
const MAX_SLOPE = (38 * Math.PI) / 180

// A bump has to rise this far above its surrounding saddle to count as a peak.
// Without a prominence test every pebble of detail noise registers and the
// spacing number just reports the detail frequency.
//
// Relative to mountainRelief rather than a fixed metre value, because a fixed
// one silently stops measuring the thing it names. At 120 m against 690 m peaks
// it reported a sensible 864 m median; the same 120 m against 175 m peaks
// disqualified nearly every summit in the world and reported 3584 m, which is
// not a bigger world -- it is a broken instrument. 0.17 is the ratio the
// original number happened to encode.
// Two thresholds, because the terrain has two tiers of peak and one number
// cannot describe both. SUB catches the 200-500 m sub-peaks riding on a flank;
// MAJOR catches the massif summits, which are the ones you navigate by and the
// ones that carry snow. Reporting only one of them is how "peak spacing" ended
// up meaning whichever tier the threshold happened to land in.
//
// Both are fractions of the FULL mountain height, not of mountainRelief. Keyed
// to mountainRelief they silently rescaled the moment the massif tier took over
// most of the elevation -- the third time an instrument here has drifted out
// from under the thing it names.
// Divided by SHRINK: TUNING is in pre-shrink units and H below is not. Getting
// this wrong is the same drift as above wearing a different hat -- the numbers
// would still be self-consistent and would still describe the wrong world.
const TOTAL_RELIEF = (TUNING.massifRelief + TUNING.mountainRelief) / SHRINK
const PROMINENCE = 0.06 * TOTAL_RELIEF
const PROMINENCE_MAJOR = 0.25 * TOTAL_RELIEF

const th = new TerrainHeight(SEED)

const t0 = performance.now()
const H = new Float32Array(N * N)
for (let j = 0; j < N; j++) {
  const z = -WORLD_HALF + j * STEP
  for (let i = 0; i < N; i++) H[j * N + i] = th.heightAt(-WORLD_HALF + i * STEP, z)
}
const sampleMs = performance.now() - t0

// --- elevation ---------------------------------------------------------------

const sorted = Float32Array.from(H).sort()
const pct = (p) => sorted[Math.floor(p * (sorted.length - 1))]

console.log(`\n=== terrain probe, seed ${SEED} ===`)
console.log(`${N}x${N} samples at ${STEP}m over ${WORLD_SIZE / 1000}km  (${sampleMs.toFixed(0)}ms)\n`)
console.log('elevation')
console.log(
  `        min ${pct(0).toFixed(0)}  p10 ${pct(0.1).toFixed(0)}  median ${pct(0.5).toFixed(0)}  ` +
    `p90 ${pct(0.9).toFixed(0)}  p99 ${pct(0.99).toFixed(0)}  max ${pct(1).toFixed(0)} m`
)

// --- slope -------------------------------------------------------------------
// From the grid itself rather than from normalAt, so this measures the relief at
// the scale you actually walk across rather than at the scale of a 0.75 m probe.

let walkable = 0
let cells = 0
const slopeHist = new Array(9).fill(0) // 0-10, 10-20, ... 80-90 degrees
for (let j = 1; j < N - 1; j++) {
  for (let i = 1; i < N - 1; i++) {
    const dx = (H[j * N + i + 1] - H[j * N + i - 1]) / (2 * STEP)
    const dz = (H[(j + 1) * N + i] - H[(j - 1) * N + i]) / (2 * STEP)
    const deg = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI
    slopeHist[Math.min(8, Math.floor(deg / 10))]++
    cells++
    if (Math.atan(Math.hypot(dx, dz)) <= MAX_SLOPE) walkable++
  }
}
console.log('\nslope')
console.log(`        walkable (<=38deg at ${STEP}m) ${((100 * walkable) / cells).toFixed(1)}%`)
for (let b = 0; b < slopeHist.length; b++) {
  const f = slopeHist[b] / cells
  if (f < 0.002) continue
  console.log(
    `        ${String(b * 10).padStart(2)}-${String(b * 10 + 10).padStart(2)}deg ` +
      `${(100 * f).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(f * 120))}`
  )
}

// --- ridge spacing -----------------------------------------------------------
// Peaks with real prominence along a transect, then the gaps between them. This
// is the number that says "Skyrim valley" or "continental basin".

function peaksAlong(line, prominence = PROMINENCE) {
  const peaks = []
  for (let i = 1; i < line.length - 1; i++) {
    if (!(line[i] > line[i - 1] && line[i] >= line[i + 1])) continue
    // Prominence: walk out both ways to the first higher ground, keeping the
    // lowest point crossed. The peak counts if it clears the higher of the two
    // saddles by PROMINENCE.
    let lo = line[i]
    let k = i
    while (k > 0 && line[k] <= line[i]) lo = Math.min(lo, line[k--])
    const left = k === 0 ? -Infinity : lo
    lo = line[i]
    k = i
    while (k < line.length - 1 && line[k] <= line[i]) lo = Math.min(lo, line[k++])
    const right = k === line.length - 1 ? -Infinity : lo
    const saddle = Math.max(left, right)
    if (saddle === -Infinity) continue
    if (line[i] - saddle >= prominence) peaks.push(i)
  }
  return peaks
}

const gaps = []
const gapsMajor = []
const floors = []
for (let t = 0; t < N; t += 4) {
  for (const axis of [0, 1]) {
    const line = new Float32Array(N)
    for (let i = 0; i < N; i++) line[i] = axis === 0 ? H[t * N + i] : H[i * N + t]

    const peaks = peaksAlong(line)
    for (let p = 1; p < peaks.length; p++) gaps.push((peaks[p] - peaks[p - 1]) * STEP)

    const major = peaksAlong(line, PROMINENCE_MAJOR)
    for (let p = 1; p < major.length; p++) gapsMajor.push((major[p] - major[p - 1]) * STEP)

    // Valley floor: a contiguous run that stays below the midpoint between this
    // transect's own low and high ground. Relative rather than absolute, so a
    // high alpine basin still reads as a floor.
    let lo = Infinity
    let hi = -Infinity
    for (const v of line) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (hi - lo < PROMINENCE) continue
    const cut = lo + (hi - lo) * 0.35
    let run = 0
    for (let i = 0; i < N; i++) {
      if (line[i] < cut) {
        run++
      } else {
        if (run > 1) floors.push(run * STEP)
        run = 0
      }
    }
    if (run > 1) floors.push(run * STEP)
  }
}

const stat = (a) => {
  if (a.length === 0) return 'none found'
  const s = Float32Array.from(a).sort()
  const q = (p) => s[Math.floor(p * (s.length - 1))]
  const mean = a.reduce((x, y) => x + y, 0) / a.length
  return `n=${a.length}  p25 ${q(0.25).toFixed(0)}  median ${q(0.5).toFixed(0)}  mean ${mean.toFixed(0)}  p75 ${q(0.75).toFixed(0)}  p95 ${q(0.95).toFixed(0)} m`
}

console.log('\nhorizontal scale')
console.log(`        sub-peak to sub-peak (prom >=${PROMINENCE.toFixed(0)}m)  ${stat(gaps)}`)
console.log(`        massif to massif     (prom >=${PROMINENCE_MAJOR.toFixed(0)}m) ${stat(gapsMajor)}`)
console.log(`        valley floor run                    ${stat(floors)}`)

// --- snow gaps ---------------------------------------------------------------
// "You can go for kilometres in a straight line without crossing any snow" is
// the complaint this answers, and it is a different question from peak spacing:
// a peak only counts here if it is tall enough to be white. SNOW_LINE has to
// track shade() in sim/chunk-mesh.js -- it is repeated rather than imported
// because that module pulls in the whole mesh builder.

const SNOW_LINE = 148 // = 295 pre-SHRINK; must match chunk-mesh.js shade()
const snowRuns = []
for (let t = 0; t < N; t += 4) {
  for (const axis of [0, 1]) {
    let run = 0
    for (let i = 0; i < N; i++) {
      if ((axis === 0 ? H[t * N + i] : H[i * N + t]) < SNOW_LINE) run++
      else {
        if (run > 0) snowRuns.push(run * STEP)
        run = 0
      }
    }
    if (run > 0) snowRuns.push(run * STEP)
  }
}
const aboveSnow = (100 * H.filter((v) => v >= SNOW_LINE).length) / H.length
console.log(`        ${aboveSnow.toFixed(1)}% of the map is above the ${SNOW_LINE}m snow line`)
console.log(`        straight-line gap between snow           ${stat(snowRuns)}`)

// --- summit apex angle -------------------------------------------------------
// "It should be rare to have a pinnacle whose horizon angle is less than 30
// degrees" is a shape complaint, and shape complaints have to become numbers or
// the next tuning pass is guesswork again. So: find real 2D summits, then
// measure the cone each one sits on.
//
// A summit here is a cell that peaksAlong() accepted on BOTH its row and its
// column. That is a cheap stand-in for true 2D prominence (which needs a
// flood-fill from every candidate) and it rejects the thing that matters --
// shoulders on a slope, which pass in one axis and fail in the other.
//
// Apex angle is measured against the MEAN of a ring rather than its min, so a
// summit perched on the end of a spur is judged by all its sides rather than
// flattered by the one that leans against higher ground. Two radii because the
// answer differs: a peak can be broad at 64 m and still carry a needle at 24.

const rowPeak = new Uint8Array(N * N)
const summits = []
for (let t = 0; t < N; t++) {
  const row = new Float32Array(N)
  for (let i = 0; i < N; i++) row[i] = H[t * N + i]
  for (const p of peaksAlong(row)) rowPeak[t * N + p] = 1
}
for (let t = 0; t < N; t++) {
  const col = new Float32Array(N)
  for (let i = 0; i < N; i++) col[i] = H[i * N + t]
  for (const p of peaksAlong(col)) if (rowPeak[p * N + t]) summits.push([t, p])
}

const RADII = [24, 64]
const apex = RADII.map(() => [])
for (const [i, j] of summits) {
  const x = -WORLD_HALF + i * STEP
  const z = -WORLD_HALF + j * STEP
  const top = H[j * N + i]
  for (let r = 0; r < RADII.length; r++) {
    let sum = 0
    for (let a = 0; a < 16; a++) {
      const th2 = (a / 16) * Math.PI * 2
      sum += th.heightAt(x + Math.cos(th2) * RADII[r], z + Math.sin(th2) * RADII[r])
    }
    const drop = top - sum / 16
    apex[r].push(drop <= 0 ? 180 : (2 * Math.atan(RADII[r] / drop) * 180) / Math.PI)
  }
}

console.log('\nsummit apex angle')
console.log(`        ${summits.length} summits (peak in both axes, prominence >=${PROMINENCE.toFixed(0)}m)`)
for (let r = 0; r < RADII.length; r++) {
  const s = Float32Array.from(apex[r]).sort()
  if (s.length === 0) {
    console.log(`        at ${RADII[r]}m: none`)
    continue
  }
  const q = (p) => s[Math.floor(p * (s.length - 1))].toFixed(0)
  const under = (deg) => ((100 * s.findIndex((v) => v >= deg)) / s.length).toFixed(1)
  console.log(
    `        at ${String(RADII[r]).padStart(2)}m  p5 ${q(0.05)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}deg` +
      `   <30deg ${under(30)}%  <60deg ${under(60)}%`
  )
}

// --- unbroken flat ground ----------------------------------------------------
// "Many wide open unbroken plains 4+km across" needs to be a measurement too.
// Flat = the 64 m window centred on this sample has less than FLAT_RELIEF of
// relief in it; then 4-connected components of those samples, reported as the
// diameter of the equal-area circle.
//
// The percentiles are AREA-WEIGHTED -- they answer "how big is the plain you
// are standing in", not "how big is the average puddle of flatness". Unweighted,
// ten thousand single-cell specks would drown out one 4 km basin, which is
// exactly the thing being looked for.

const FLAT_RELIEF = 6
const flat = new Uint8Array(N * N)
for (let j = 1; j < N - 1; j++) {
  for (let i = 1; i < N - 1; i++) {
    let lo = Infinity
    let hi = -Infinity
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const v = H[(j + dj) * N + i + di]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (hi - lo < FLAT_RELIEF) flat[j * N + i] = 1
  }
}

const plains = []
const stack = []
for (let s = 0; s < N * N; s++) {
  if (flat[s] !== 1) continue
  let area = 0
  stack.push(s)
  flat[s] = 2
  while (stack.length) {
    const c = stack.pop()
    area++
    const ci = c % N
    const cj = (c - ci) / N
    if (ci > 0 && flat[c - 1] === 1) (flat[c - 1] = 2), stack.push(c - 1)
    if (ci < N - 1 && flat[c + 1] === 1) (flat[c + 1] = 2), stack.push(c + 1)
    if (cj > 0 && flat[c - N] === 1) (flat[c - N] = 2), stack.push(c - N)
    if (cj < N - 1 && flat[c + N] === 1) (flat[c + N] = 2), stack.push(c + N)
  }
  plains.push(area * STEP * STEP)
}

console.log('\nunbroken flat ground')
const flatFrac = (100 * plains.reduce((a, b) => a + b, 0)) / (N * N * STEP * STEP)
if (plains.length === 0) {
  console.log(`        none (no 64m window under ${FLAT_RELIEF}m of relief)`)
} else {
  plains.sort((a, b) => a - b)
  const total = plains.reduce((a, b) => a + b, 0)
  const dia = (m2) => (2 * Math.sqrt(m2 / Math.PI)).toFixed(0)
  const wq = (p) => {
    let acc = 0
    for (const a of plains) {
      acc += a
      if (acc >= p * total) return dia(a)
    }
    return dia(plains[plains.length - 1])
  }
  console.log(`        ${(flatFrac).toFixed(1)}% of the map is flat (<${FLAT_RELIEF}m over 64m), in ${plains.length} regions`)
  console.log(
    `        plain diameter, area-weighted: p25 ${wq(0.25)}  median ${wq(0.5)}  p75 ${wq(0.75)}  largest ${dia(plains[plains.length - 1])} m`
  )
}

console.log('\ntuning in effect')
for (const [k, v] of Object.entries(TUNING)) console.log(`        ${k.padEnd(18)} ${v}`)
console.log()
