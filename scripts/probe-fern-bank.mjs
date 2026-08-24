// Price a concrete fern variant bank: triangle counts, arena bytes, and the
// shape outliers that a combinatorial sweep produces but nobody looked at.
//
//   node scripts/probe-fern-bank.mjs
//
// Triangle count is exactly fronds * segments * 2 (each frond is a ribbon of
// `segments` quads), so the bank's cost is decided entirely by the fronds and
// segments axes. The other axes are free.

import { buildFern, FERN_DEFAULTS, geometryBytes } from '../src/props/fern.js'

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

const AXES = {
  fronds: [4, 6, 10],
  pitch: [1.55, 1.2, 1.0],
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

const TIERS = { LOD0: 8, LOD1: 4 }

console.log(`\n${combos.length} variants x ${Object.keys(TIERS).length} tiers = ${combos.length * Object.keys(TIERS).length} baked geometries`)
console.log(`axes: ${Object.entries(AXES).map(([k, v]) => `${k}[${v.join(',')}]`).join('  ')}\n`)

const report = {}
for (const [tier, segments] of Object.entries(TIERS)) {
  let bytes = 0
  let verts = 0
  let tris = 0
  let minTris = Infinity
  let maxTris = 0
  const shapes = []
  combos.forEach((c, i) => {
    const g = buildFern({ ...FERN_DEFAULTS, ...BASE, ...c, segments, seed: 100 + i })
    const t = g.index.count / 3
    tris += t
    if (t < minTris) minTris = t
    if (t > maxTris) maxTris = t
    verts += g.attributes.position.count
    bytes += geometryBytes(g)
    g.computeBoundingBox()
    const bb = g.boundingBox
    shapes.push({
      i,
      c,
      tris: t,
      h: bb.max.y - bb.min.y,
      w: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z),
    })
    g.dispose()
  })
  report[tier] = { bytes, verts, tris, minTris, maxTris, shapes }
  console.log(
    `${tier} (segments ${segments}): ${minTris}-${maxTris} tris per variant, ` +
      `${(tris / combos.length).toFixed(0)} avg, ${tris} total, ${verts} verts, ${(bytes / 1024).toFixed(1)} KB`
  )
}

const totalBytes = Object.values(report).reduce((n, r) => n + r.bytes, 0)
const totalVerts = Object.values(report).reduce((n, r) => n + r.verts, 0)
console.log(`\nwhole bank: ${(totalBytes / 1024).toFixed(1)} KB, ${totalVerts} verts in the batch arena`)

// Against the bush class's shipped per-instance budget.
console.log('\nwhat a frame costs at these tiers (DESIGN.md §5 bush-class counts):')
for (const [tier, n, label] of [
  ['LOD0', 900, '0-12 m'],
  ['LOD1', 2000, '25-60 m'],
]) {
  const r = report[tier]
  const avg = r.tris / combos.length
  console.log(
    `  ${n} instances x ${avg.toFixed(0)} avg tris (${label}) = ${((n * avg) / 1000).toFixed(0)}k tris` +
      `   [budget row assumed ${tier === 'LOD0' ? 42 : 12}, i.e. ${((n * (tier === 'LOD0' ? 42 : 12)) / 1000).toFixed(0)}k]`
  )
}

// Shape sanity. A frond launched at `pitch` and bent by `arch` ends up pointing
// pitch-arch above horizontal; negative means the tip is below the crown, which
// past about -0.5 rad is an umbrella rather than a fern.
console.log('\nshape outliers -- tip elevation = pitch - arch, radians:')
const seen = new Set()
for (const s of report.LOD0.shapes) {
  const tip = s.c.pitch - s.c.arch
  const key = `${s.c.pitch}/${s.c.arch}`
  if (seen.has(key)) continue
  seen.add(key)
  const flag = tip < -0.5 ? '  <-- tip well below the crown' : ''
  console.log(
    `  pitch ${s.c.pitch.toFixed(2)}  arch ${s.c.arch.toFixed(2)}  tip ${tip >= 0 ? '+' : ''}${tip.toFixed(2)} rad ` +
      `(${((tip * 180) / Math.PI).toFixed(0)} deg)  w/h ${(s.w / s.h).toFixed(2)}${flag}`
  )
}
