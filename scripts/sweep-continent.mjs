// Parameter sweep for the continent tier (TUNING.continent*), DESIGN.md §3.
//
// The tier trades two things against each other. `continentTilt` is the blend
// between an irregular low-frequency fbm -- which gives distinct areas each at
// their own default height -- and a linear ramp, which gives the map a
// consistent downhill so water always has somewhere to go. All noise and no
// ramp measured 89.6% reachable with 24% of the map flooded in sealed lows; all
// ramp and no noise is a featureless tilted plane. The corner is in between and
// this finds it.
//
// Columns:
//   reach%   fraction of the world walkable from spawn. HARD GATE -- a fenced
//            world is worthless however good it looks.
//   r4km     relief surviving a 4 km blur; what the tier exists to raise.
//            Before the tier this was 7.8%.
//   cut      deepest breach cut, metres: the ugliness proxy, since breaching
//            through a rim leaves a trench that no splining hides.
//   spread   p10..p90 span of the continent field alone, in metres of ground.
//            This is the "different regions at different base heights" number.
//
// Run: node scripts/sweep-continent.mjs [gridN]   (1024 minimum -- see below)
//
// RESOLUTION MATTERS AND THE DEFAULT IS NOT 512. At 512^2 the cell is 32 m, an
// escarpment drop is averaged across one cell, and cliffs and basin rims both
// vanish into the sampling: every config measured 100% reachable with zero
// lakes, including ones that were catastrophically fenced at 1024^2. A sweep
// that cannot see the failure it exists to detect is worse than no sweep.
import { TUNING, TerrainHeight, WORLD_SIZE } from '../src/sim/terrain-height.js'
import { runPhaseA } from '../src/sim/phase-a.js'
import { sampleElevation } from '../src/sim/world-grid.js'

const N = Number(process.argv[2]) || 1024
const SEED = 20260804
const SHRINK = 2 // conformal scale at the heightAt boundary; TUNING is pre-SHRINK

// Separable box blur, run twice -- two box passes approximate a Gaussian well
// enough for a relief-survival ratio. Same method as probe-macro.mjs section 1.
//
// CAVEAT: at radius 8 km on a 1024 grid the kernel is 500 cells wide and the
// result is mostly edge clamping, which showed up as a non-monotonic spectrum
// (baseline measured 8.7% surviving at 8 km against 6.9% at 4 km, which is
// impossible). Only 4 km is reported here; probe-macro.mjs does the full
// spectrum properly and is the instrument to trust for the shape of the decay.
function blur(src, n, radiusCells) {
  let a = src, b = new Float32Array(n * n)
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) {
      const row = j * n
      let acc = 0
      for (let i = -radiusCells; i <= radiusCells; i++) acc += a[row + Math.min(n - 1, Math.max(0, i))]
      const w = radiusCells * 2 + 1
      for (let i = 0; i < n; i++) {
        b[row + i] = acc / w
        acc += a[row + Math.min(n - 1, Math.max(0, i + radiusCells + 1))] -
               a[row + Math.min(n - 1, Math.max(0, i - radiusCells))]
      }
    }
    let t = a === src ? new Float32Array(n * n) : a
    a = b; b = t
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let j = -radiusCells; j <= radiusCells; j++) acc += a[Math.min(n - 1, Math.max(0, j)) * n + i]
      const w = radiusCells * 2 + 1
      for (let j = 0; j < n; j++) {
        b[j * n + i] = acc / w
        acc += a[Math.min(n - 1, Math.max(0, j + radiusCells + 1)) * n + i] -
               a[Math.min(n - 1, Math.max(0, j - radiusCells)) * n + i]
      }
    }
    t = a; a = b; b = t
  }
  return a
}

function std(v) {
  let m = 0
  for (let i = 0; i < v.length; i++) m += v[i]
  m /= v.length
  let s = 0
  for (let i = 0; i < v.length; i++) s += (v[i] - m) * (v[i] - m)
  return Math.sqrt(s / v.length)
}

function reliefAt4km(n) {
  const elev = sampleElevation(new TerrainHeight(SEED), n)
  const rc = Math.max(1, Math.round(4000 / (WORLD_SIZE / n)))
  return std(blur(elev, n, rc)) / std(elev)
}

// p10..p90 span of the continent field alone, in metres of ground. Calls the
// terrain's own _continent so it cannot drift from the tier it is measuring.
function continentSpread(relief) {
  const th = new TerrainHeight(SEED)
  const v = []
  for (let k = 1; k <= 20000; k++) {
    const a = (k * 2654435761) >>> 0
    const x = ((a % 65536) / 65536 - 0.5) * WORLD_SIZE
    const z = (((a >>> 16) % 65536) / 65536 - 0.5) * WORLD_SIZE
    // _continent takes pre-SHRINK coordinates; its 0..1 result is scaled by
    // continentRelief and then divided by SHRINK on the way out of heightAt.
    v.push((th._continent(x * SHRINK, z * SHRINK) * relief) / SHRINK)
  }
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)]
}

const CONFIGS = [
  // name               freq     oct relief tilt skew
  ['t.35 skew 1.0',     0.00005, 3, 800, 0.35, 1.0],
  ['t.35 skew 0.7',     0.00005, 3, 800, 0.35, 0.7],
  ['t.35 skew 0.5',     0.00005, 3, 800, 0.35, 0.5],
  ['t.35 skew 0.35',    0.00005, 3, 800, 0.35, 0.35],
  ['t.5  skew 0.5',     0.00005, 3, 800, 0.50, 0.5],
  ['t.35 skew.5 rel1k', 0.00005, 3, 1000, 0.35, 0.5],
  ['t.35 skew.5 f4e-5', 0.00004, 3, 800, 0.35, 0.5],
]

console.log(`continent sweep   seed ${SEED}   grid ${N}^2   cell ${(WORLD_SIZE / N).toFixed(1)} m\n`)
console.log('  config               reach%   r4km    cut    spread')
console.log('  ' + '-'.repeat(53))

for (const [name, freq, oct, relief, tilt, skew] of CONFIGS) {
  Object.assign(TUNING, {
    continentFreq: freq,
    continentOctaves: oct,
    continentRelief: relief,
    continentTilt: tilt,
    continentSkew: skew,
  })

  let cut = 0
  const res = runPhaseA(SEED, N, (line) => {
    const m = /deepest cut (\d+)m/.exec(line)
    if (m) cut = Number(m[1])
  })

  console.log(
    '  ' + name.padEnd(20) +
    (res.reachableFraction * 100).toFixed(1).padStart(6) +
    (reliefAt4km(N) * 100).toFixed(1).padStart(7) +
    (cut + ' m').padStart(8) +
    (continentSpread(relief).toFixed(0) + ' m').padStart(9)
  )
}
