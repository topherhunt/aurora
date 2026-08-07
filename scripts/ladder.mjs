// The ratio ladder, measured two ways -- and the second one is the one that
// decides whether a world reads as a coherent range or as noise.
//
// RMS HEIGHT says how much a layer moves the ground. RMS SLOPE says how much it
// moves the *gradient*, and the eye reads gradient: a hillshade, a silhouette
// and the walkability limiter are all functions of slope, not of elevation. A
// layer with 1/20th the amplitude of the tier above it but 1/40th the wavelength
// is TWICE as steep as that tier, and it will visually dominate it however
// modest its height ladder entry looks.
import { TerrainHeight, TUNING, SHRINK } from '../src/sim/terrain-height.js'

const th = new TerrainHeight(20260804)
const N = 420
const SPAN = 1200
const O = -SPAN / 2
const step = SPAN / N

function sample() {
  const H = new Float64Array(N * N)
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) H[j * N + i] = th.heightAt(O + i * step, O + j * step)
  return H
}

// RMS of the layer's own contribution, and RMS of the SLOPE of that
// contribution -- both from the difference field (with) - (without), so each is
// the layer in isolation regardless of what it is riding on.
function measure(base, abl) {
  let d2 = 0
  let g2 = 0
  let n = 0
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i
      const d = base[k] - abl[k]
      d2 += d * d
      const dx = (base[k + 1] - abl[k + 1] - (base[k - 1] - abl[k - 1])) / (2 * step)
      const dz = (base[k + N] - abl[k + N] - (base[k - N] - abl[k - N])) / (2 * step)
      g2 += dx * dx + dz * dz
      n++
    }
  return { rms: Math.sqrt(d2 / n), slope: Math.sqrt(g2 / n) }
}

const base = sample()

const LAYERS = [
  ['swell   (2632 m)', { valleyRelief: 0 }],
  ['massif  ( 862 m)', { massifRelief: 0 }],
  ['backbone( 172 m)', { mountainRelief: 0 }],
  ['arete   ( 172 m)', { areteAmount: 0 }],
  ['jag     (  59 m)', { jagAmp: 0 }],
  ['detail  (  45 m)', { detailSoil: 0, detailRock: 0 }],
  ['crease  (  38 m)', { creaseAmp: 0 }],
  ['cliff   (10.7 m run)', { cliffAmp: 0 }],
  ['terrace ( ---  )', { terraceStrength: 0 }],
]

const rows = []
for (const [name, patch] of LAYERS) {
  const saved = {}
  for (const k in patch) {
    saved[k] = TUNING[k]
    TUNING[k] = patch[k]
  }
  rows.push([name, measure(base, sample())])
  for (const k in saved) TUNING[k] = saved[k]
}

console.log('layer                 RMS height      RMS slope (tan)     as angle')
console.log('-'.repeat(70))
for (const [name, m] of rows)
  console.log(
    `${name.padEnd(22)} ${m.rms.toFixed(2).padStart(7)} m   ${m.slope.toFixed(3).padStart(10)}   ${((Math.atan(m.slope) * 180) / Math.PI).toFixed(1).padStart(7)} deg`
  )

const sorted = [...rows].sort((a, b) => b[1].slope - a[1].slope)
console.log('\nSLOPE LADDER, steepest first -- this is the one that decides coherence.')
console.log('A hierarchy needs each rung ~2x+ below the one above it.\n')
for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i][1].slope
  const prev = i ? sorted[i - 1][1].slope : r
  console.log(
    `  ${(i + 1 + '.').padEnd(3)} ${sorted[i][0].padEnd(22)} ${r.toFixed(3).padStart(7)}${i ? `   ${(prev / r).toFixed(1)}x below the rung above` : '   <- dominates the world'}`
  )
}
