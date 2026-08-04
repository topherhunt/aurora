// Measures the SHAPE of the height field, so TUNING in sim/terrain-height.js can
// be tuned against numbers instead of against a memory of the last screenshot.
//
// The question this exists to answer is "how big is a valley here". That is not
// something you can read off a noise frequency, because domain warp, the macro
// mask and the terrace pass all move it. So: sample a grid, find ridge peaks by
// prominence along every row and column, and report the spacing between them.
//
//   node scripts/probe-terrain.mjs [seed]

import { TerrainHeight, TUNING, WORLD_SIZE, WORLD_HALF } from '../src/sim/terrain-height.js'

const SEED = Number(process.argv[2] ?? 20260804)
const STEP = 32 // m between samples
const N = Math.floor(WORLD_SIZE / STEP) + 1
const MAX_SLOPE = (38 * Math.PI) / 180

// A bump has to rise this far above its surrounding saddle to count as a peak.
// Without a prominence test every pebble of detail noise registers and the
// spacing number just reports the detail frequency.
const PROMINENCE = 120

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

function peaksAlong(line) {
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
    if (line[i] - saddle >= PROMINENCE) peaks.push(i)
  }
  return peaks
}

const gaps = []
const floors = []
for (let t = 0; t < N; t += 4) {
  for (const axis of [0, 1]) {
    const line = new Float32Array(N)
    for (let i = 0; i < N; i++) line[i] = axis === 0 ? H[t * N + i] : H[i * N + t]

    const peaks = peaksAlong(line)
    for (let p = 1; p < peaks.length; p++) gaps.push((peaks[p] - peaks[p - 1]) * STEP)

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
console.log(`        peak-to-peak (prominence >=${PROMINENCE}m)   ${stat(gaps)}`)
console.log(`        valley floor run                    ${stat(floors)}`)

console.log('\ntuning in effect')
for (const [k, v] of Object.entries(TUNING)) console.log(`        ${k.padEnd(18)} ${v}`)
console.log()
