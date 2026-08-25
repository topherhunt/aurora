// Price a concrete fern variant bank and check its shapes.
//
//   node scripts/probe-fern-bank.mjs
//
// Triangle count is exactly fronds * segments * 2 (each frond is a ribbon of
// `segments` quads), so segments is a straight multiplier on the whole bank and
// the only interesting question is which distance band pays which multiplier.

import { buildFern, FERN_DEFAULTS, geometryBytes } from '../src/props/fern.js'
import { FERN_CARD_PLANES } from '../src/props/fern-bank.js'
import { TRI_BUDGET } from '../src/budget.js'

// The proposed spec. `pitchFalloff` is spelled as the generator spells it.
const BASE = {
  curve: 1.6,
  pitchFalloff: 0.5,
  lengthVar: 0.5,
  widthScale: 1.2,
  sway: 1.2,
  roll: 0.7,
  yawJitter: 0,
  crownRadius: 0,
  crozier: 0,
}

// LOCKED, and TASKS.md carries the same list. 16 variants, not 36: the axes
// were halved on purpose. `fronds` 5 and 9 average higher than 4/6/10 did, so
// this bank is slightly MORE triangles per fern and less than half the resident
// bytes -- cost moved from the pool, which is fixed, to the frame, which has
// headroom. If you change these, change TASKS.md in the same commit.
const AXES = {
  fronds: [5, 9],
  pitch: [1.0, 1.4],
  arch: [0.6, 2],
  taper: [0, 0.6],
}

const combos = []
{
  const keys = Object.keys(AXES)
  const rec = (i, acc) => {
    if (i === keys.length) return combos.push({ ...acc })
    for (const v of AXES[keys[i]]) rec(i + 1, { ...acc, [keys[i]]: v })
  }
  rec(0, {})
}

// Three mesh tiers plus one shared card.
const TIERS = { LOD0: 6, LOD1: 4, LOD2: 2 }

// Imported rather than written as 4, because this row is the only place the
// card's cost is priced against a frame and a stale copy of it would quietly
// halve the far band. Crossed quads, two triangles each.
const CARD_TRIS = FERN_CARD_PLANES * 2

console.log(`\n=== bank: ${combos.length} variants x ${Object.keys(TIERS).length} tiers = ${combos.length * Object.keys(TIERS).length} baked geometries ===`)
console.log(`axes: ${Object.entries(AXES).map(([k, v]) => `${k}[${v.join(',')}]`).join('  ')}`)
console.log(`tiers: ${Object.entries(TIERS).map(([k, v]) => `${k}=${v}seg`).join('  ')}\n`)

const tierAvg = {}
let bankBytes = 0
for (const [tier, segments] of Object.entries(TIERS)) {
  let bytes = 0
  let tris = 0
  let lo = Infinity
  let hi = 0
  combos.forEach((c, i) => {
    const g = buildFern({ ...FERN_DEFAULTS, ...BASE, ...c, segments, seed: 100 + i })
    const t = g.index.count / 3
    tris += t
    if (t < lo) lo = t
    if (t > hi) hi = t
    bytes += geometryBytes(g)
    g.dispose()
  })
  tierAvg[tier] = tris / combos.length
  bankBytes += bytes
  console.log(
    `${tier} (${segments} seg): ${lo}-${hi} tris, ${tierAvg[tier].toFixed(0)} avg, ${(bytes / 1024).toFixed(1)} KB`
  )
}
console.log(`\nwhole bank: ${(bankBytes / 1024).toFixed(1)} KB of vertex+index data`)
console.log(`for scale, the terrain slot pool is a fixed ~16 MB (terrain.js SLOT_COUNT)`)

// --- what a frame actually costs -------------------------------------------
//
// The band populations, not the tier costs, decide this. A disc of radius r
// holds pi*r^2*density ferns; per-instance frustum culling leaves the fraction
// of it inside the ~89 deg Quest 2 cone.

const DENSITY = 2.0 // ferns per m^2, "lush fernscape"
const FOV_FRAC = 89 / 360

const ring = (r0, r1) => Math.PI * (r1 * r1 - r0 * r0) * DENSITY * FOV_FRAC

console.log(`\n=== a frame, at ${DENSITY} ferns/m^2 with ${(FOV_FRAC * 100).toFixed(0)}% of the disc in cone ===\n`)

const bands = [
  ['LOD0', 0, 5, tierAvg.LOD0],
  ['LOD1', 5, 10, tierAvg.LOD1],
  ['LOD2', 10, 25, tierAvg.LOD2],
  ['card', 25, 60, CARD_TRIS],
]

console.log('band     range      instances   tris each   total')
let totalTris = 0
let totalInst = 0
for (const [name, r0, r1, per] of bands) {
  const n = Math.round(ring(r0, r1))
  const t = n * per
  totalTris += t
  totalInst += n
  console.log(
    `${name.padEnd(8)} ${`${r0}-${r1} m`.padEnd(10)} ${String(n).padStart(9)}   ${per.toFixed(0).padStart(9)}   ${`${(t / 1000).toFixed(1)}k`.padStart(6)}`
  )
}
console.log(
  `${'TOTAL'.padEnd(19)} ${String(totalInst).padStart(9)}   ${''.padStart(9)}   ${`${(totalTris / 1000).toFixed(1)}k`.padStart(6)}` +
    `   = ${((totalTris / TRI_BUDGET) * 100).toFixed(1)}% of ${TRI_BUDGET / 1000}k`
)
console.log(
  `\nfor comparison, one flat tier at 6 segments everywhere to 25 m: ` +
    `${((Math.round(ring(0, 25)) * tierAvg.LOD0) / 1000).toFixed(0)}k tris`
)

// --- shape: does the tip actually droop below the crown? --------------------
//
// The frond tip's DIRECTION is pitch - arch*s^curve at s=1, which is pitch-arch
// regardless of curve -- curve moves where along the frond the bend happens, not
// where it ends up pointing. So the question "does it droop below the crown" is
// about the tip's POSITION, which curve very much does change. Measure it.

console.log('\n=== shape: tip height vs crown height, at curve 1.6 ===\n')
console.log('Geometry is rescaled to `height` and sat on y=0, so nothing is ever')
console.log('underground. The question is whether the tip falls below the crown.\n')
console.log('pitch  arch   crown y   tip y   lowest y   tip vs crown   verdict')

const CURVES = [1.6]
for (const curve of CURVES) {
  for (const pitch of AXES.pitch) {
    for (const arch of AXES.arch) {
      const g = buildFern({
        ...FERN_DEFAULTS,
        ...BASE,
        curve,
        fronds: 9,
        pitch,
        arch,
        taper: 0,
        segments: 6,
        seed: 7,
      })
      const pos = g.attributes.position.array
      // Fronds are emitted in order, each contributing (segments+1)*2 verts.
      // Vertex 0-1 of a frond is its base (the crown), the last pair is its tip.
      const perFrond = (6 + 1) * 2 // segments 6 -> 7 rings of 2 verts
      let crownY = 0
      let tipY = 0
      let lowest = Infinity
      const n = pos.length / 3
      for (let v = 0; v < n; v++) {
        const y = pos[v * 3 + 1]
        if (y < lowest) lowest = y
        const k = v % perFrond
        if (k < 2) crownY += y / 2
        if (k >= perFrond - 2) tipY += y / 2
      }
      const fronds = n / perFrond
      crownY /= fronds
      tipY /= fronds
      const h = g.boundingBox ? 0 : 0
      g.computeBoundingBox()
      const height = g.boundingBox.max.y - g.boundingBox.min.y
      const drop = tipY - crownY
      const verdict =
        tipY < 0.02 * height
          ? 'tip on the ground'
          : drop < -0.25 * height
            ? 'tip well below crown'
            : drop < -0.02 * height
              ? 'tip below crown -- droops'
              : 'tip at or above crown'
      console.log(
        `${pitch.toFixed(2).padStart(5)}  ${arch.toFixed(1).padStart(4)}   ` +
          `${crownY.toFixed(3).padStart(7)}  ${tipY.toFixed(3).padStart(6)}   ` +
          `${lowest.toFixed(3).padStart(8)}   ${(drop >= 0 ? '+' : '') + drop.toFixed(3).padStart(6)}       ${verdict}`
      )
      g.dispose()
    }
  }
}
console.log(`\n(fern height is ${FERN_DEFAULTS.height} m; y is metres above ground)`)
